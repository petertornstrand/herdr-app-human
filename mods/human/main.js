// Human: a checklist of instructions the agents have given you.
//   mod.open:human                    a popup
//   pane.split {mod: "human"}         a side pane
//
// Agents append one JSON object per line to ~/.config/herdr-app/human/inbox.jsonl
// (see human-add). The mod never edits that file; what you have checked off or
// removed is kept in ~/.config/herdr-app/human/state.json.
//   inbox line: {"id","ts","project","text","cmd"?,"terminal"?}   (cmd is copyable as is)
//
// The list shows the shown space's items: an item whose terminal is in another
// space is hidden (the header button shows all). An item whose terminal is gone
// or unknown is always shown, so nothing is lost when a terminal closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, appHome, readTextFile, writeTextFile, watchFolder, theme, settings, checking, props, notify, agents, focused, spaces, closeOverlay } from "herdr";

// A window is dragged by any press the mod doesn't stop: controls stop theirs.
const stop = (_e, cx) => cx.stop_propagation();

const DIR = () => `${appHome()}/human`;
const INBOX = () => `${DIR()}/inbox.jsonl`;
const STATE = () => `${DIR()}/state.json`;

function parseInbox(text) {
  const items = [];
  const seen = new Set();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!o || typeof o.text !== "string" || !o.id || seen.has(o.id)) continue;
      seen.add(o.id);
      items.push({ id: String(o.id), ts: o.ts ?? null, project: o.project ?? null, text: o.text, cmd: o.cmd ?? null, retry: o.retry ?? null, terminal: o.terminal ?? null, wait: o.wait === true });
    } catch {
      // A half-written line: picked up on the next change.
    }
  }
  return items;
}

function parseState(text) {
  try {
    const s = JSON.parse(text ?? "{}");
    return { done: s.done && typeof s.done === "object" ? s.done : {}, removed: Array.isArray(s.removed) ? s.removed : [] };
  } catch {
    return { done: {}, removed: [] };
  }
}

function ago(ts) {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

async function copyText(text) {
  // exec has no stdin: the text goes in as $1.
  for (const tool of ["wl-copy", "xclip -selection clipboard", "xsel --clipboard --input"]) {
    try {
      const r = await exec("sh", ["-c", `printf %s "$1" | ${tool}`, "sh", text], { timeout: 3000 });
      if (r.code === 0) return true;
    } catch {
      // Try the next tool.
    }
  }
  return false;
}

export default class Human extends View {
  init(_props, cx) {
    this.items = [];
    this.state = { done: {}, removed: [] };
    this.stateRaw = null;
    this.loaded = false;
    this.error = null;
    this.showDone = true;
    this.showAll = true; // items from every space; the header button narrows it to the shown space
    this.lastSpace = null; // the last space seen focused (focus can be null in a popup)
    if (checking()) return;
    this.reload(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(DIR());
        } catch {
          // The folder may not exist yet; wait and retry.
          await new Promise((done) => cx.timer.after(5000, () => done()));
        }
        await this.load();
        cx.notify();
      }
    });
    // Relative times ("5 min") age on their own.
    cx.timer.every(60000, (cx) => cx.notify());
    // The list follows the shown space: redraw when it changes.
    cx.timer.every(1500, (cx) => {
      const now = focused()?.space ?? null;
      if (now && now !== this.lastSpace) cx.notify();
    });
  }

  /** The space an item's terminal is in now, or null (no terminal, or it is gone). */
  spaceOf(item, list) {
    if (!item.terminal) return null;
    const a = list.find((x) => x.address === item.terminal || x.address.endsWith(`/${item.terminal}`));
    return a ? a.space : null;
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });
  }

  async load() {
    try {
      this.items = parseInbox(await readTextFile(INBOX()));
      this.stateRaw = await readTextFile(STATE());
      this.state = parseState(this.stateRaw);
      this.error = null;
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.loaded = true;
  }

  /** Change state.json from its latest content, so a second copy's change isn't lost. */
  mutate(fn, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.load();
        const s = this.state;
        fn(s);
        const next = JSON.stringify(s, null, 2) + "\n";
        await writeTextFile(STATE(), next, this.stateRaw);
        this.stateRaw = next;
      } catch (e) {
        // Stale snapshot (another copy wrote first): reload and show the truth.
        notify({ title: "Human", body: String(e?.message ?? e), level: "error", timeout: 4000 });
        await this.load();
      }
      cx.notify();
    });
  }

  toggle(item, cx) {
    const checking = !this.state.done[item.id];
    this.mutate((s) => {
      if (s.done[item.id]) delete s.done[item.id];
      else s.done[item.id] = new Date().toISOString();
    }, cx);
    // An agent waiting for this gets told when it's done (not when it's unchecked).
    if (checking && item.wait && item.terminal) {
      cx.spawn(async (cx) => {
        let ok = false;
        try {
          ok = (await hc(["send", item.terminal, `Done by the human: "${item.text}". Continue.`])).code === 0;
        } catch {
          // Reported below.
        }
        if (!ok) notify({ title: `The agent didn't get the news (${item.terminal})`, body: item.text, level: "warning", timeout: 5000 });
      });
    }
  }

  remove(item, cx) {
    this.mutate((s) => {
      if (!s.removed.includes(item.id)) s.removed.push(item.id);
      delete s.done[item.id];
    }, cx);
  }

  /** Send the task back to the agent that made it; the row goes away only if the agent got the message. */
  reject(item, cx) {
    if (!item.terminal) {
      notify({ title: "Human", body: "No agent is registered on this item.", level: "error", timeout: 4000 });
      return;
    }
    cx.spawn(async (cx) => {
      const msg = `Rejected by the human: "${item.text}"${item.cmd ? ` (${item.cmd})` : ""}. Do it yourself. Only if you cannot: human-add --retry '<why you could not>' '<text>'.`;
      let ok = false;
      let why = "";
      try {
        const r = await hc(["send", item.terminal, msg]);
        ok = r.code === 0;
        why = (r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0];
      } catch (e) {
        why = String(e?.message ?? e);
      }
      if (!ok) {
        notify({ title: `No agent received it (${item.terminal})`, body: why || "The terminal is gone.", level: "error", timeout: 6000 });
        return;
      }
      this.remove(item, cx);
      notify({ title: "Sent back to the agent", body: item.text, level: "success", timeout: 2500 });
    });
  }

  clearDone(cx) {
    this.mutate((s) => {
      for (const id of Object.keys(s.done)) if (!s.removed.includes(id)) s.removed.push(id);
      s.done = {};
    }, cx);
  }

  copy(item, cx) {
    cx.spawn(async (cx) => {
      // The command if there is one, else the instruction itself.
      const payload = item.cmd ?? item.text;
      const ok = await copyText(payload);
      notify({ title: ok ? "Copied" : "No clipboard tool found", body: ok ? payload : "Install wl-copy or xclip.", level: ok ? "success" : "error", timeout: 2500 });
    });
  }

  render() {
    const t = theme();
    const current = focused()?.space ?? this.lastSpace;
    if (current) this.lastSpace = current;
    const live = agents();
    const mine = (i) => {
      const sp = this.spaceOf(i, live);
      return !current || !sp || sp === current;
    };
    const unremoved = this.items.filter((i) => !this.state.removed.includes(i.id)).reverse(); // newest first
    const visible = this.showAll ? unremoved : unremoved.filter(mine);
    const hidden = unremoved.filter((i) => !this.state.done[i.id] && !mine(i)).length;
    // What an agent is waiting for comes first; the sort is stable, so the rest stays newest first.
    const open = visible.filter((i) => !this.state.done[i.id]).sort((a, b) => Number(b.wait) - Number(a.wait));
    const done = visible.filter((i) => this.state.done[i.id]);

    const button = (id, label, onClick, strong) =>
      div().id(id).flex_none().px(10).h(22).rounded(4).flex().items_center().text_size(12)
        .border(1).border_color(strong ? t.accent : t.border)
        .text_color(strong ? t.accent : t.foreground)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => onClick(cx)).child(label);

    const row = (item) => {
      const checked = Boolean(this.state.done[item.id]);
      const age = item.ts ? ago(item.ts) : "";
      const link = (id, label, onClick) =>
        div().id(`${id}-${item.id}`).flex_none().px(8).h(22).rounded(4).flex().items_center().text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => onClick(cx)).child(label);
      const canReject = !checked && !item.retry && Boolean(item.terminal);

      return v_flex().flex_none().p(12).gap(8).rounded(8).border(1)
        .border_color((item.retry || item.wait) && !checked ? t.blocked : t.border)
        .bg(checked ? t.surface : t.raised)
        // The instruction, with the box that checks it off.
        .child(h_flex().gap(10).items_start()
          .child(
            div().id(`box-${item.id}`).size(20).mt(1).flex_none().rounded(5).flex().items_center().justify_center()
              .border(1.5).border_color(checked ? t.accent : t.input)
              .when(checked, (el) => el.bg(t.accent).text_color(t.accent_foreground).text_size(13).child("✓"))
              .hover((s) => s.border_color(t.accent))
              .on_mouse_down("left", stop).on_click((_e, cx) => this.toggle(item, cx)))
          .child(
            div().id(`text-${item.id}`).flex_1().min_w(0).text_size(14).text_color(checked ? t.dim : t.foreground)
              .when(checked, (el) => el.line_through()).whitespace_normal()
              .on_mouse_down("left", stop).on_click((_e, cx) => this.copy(item, cx)).child(item.text)))
        // The command, to copy as is.
        .when(Boolean(item.cmd) && !checked, (el) =>
          el.child(div().id(`cmd-${item.id}`).ml(30).px(10).py(7).rounded(6).bg(t.background).border(1).border_color(t.border)
            .font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(checked ? t.dim : t.foreground)
            .whitespace_normal().hover((s) => s.border_color(t.accent)).on_mouse_down("left", stop).on_click((_e, cx) => this.copy(item, cx)).child(item.cmd)))
        .when(item.wait && !checked, (el) =>
          el.child(div().ml(30).self_start().px(8).h(20).rounded(10).flex().items_center().text_size(11).font_semibold()
            .border(1).border_color(t.blocked).text_color(t.blocked).child("● Agent is waiting for you")))
        .when(Boolean(item.retry) && !checked, (el) =>
          el.child(div().ml(30).text_size(12).text_color(t.blocked).whitespace_normal().child(`Agent could not: ${item.retry}`)))
        // Where it came from, and what you can do with it.
        .child(h_flex().ml(30).gap(2).items_center()
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).truncate().child([item.project, age].filter(Boolean).join(" · ")))
          .child(link("copy", "Copy", (cx) => this.copy(item, cx)))
          .when(canReject, (el) => el.child(link("rej", "Reject", (cx) => this.reject(item, cx))))
          .child(link("rm", "Remove", (cx) => this.remove(item, cx))));
    };

    const section = (title) =>
      div().px(14).pt(6).pb(0).flex_none().text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase());

    // "All spaces": the open items grouped by the space their terminal is in
    // (the shown one first, then the others in space order), and those with no
    // known space last. Two spaces with the same name get their folder added.
    const grouped = (list) => {
      const all = spaces();
      const base = (p) => (p ?? "").split("/").filter(Boolean).pop() ?? "";
      const label = (s) => {
        const same = all.filter((x) => x.name === s.name);
        if (same.length < 2) return s.name;
        const withFolder = `${s.name} · ${base(s.folder) || "~"}`;
        return all.filter((x) => `${x.name} · ${base(x.folder) || "~"}` === withFolder).length < 2 ? withFolder : `${withFolder} #${s.index}`;
      };
      const groups = new Map();
      for (const item of list) {
        const sp = this.spaceOf(item, live);
        const key = all.some((s) => s.id === sp) ? sp : null;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const order = (key) => (key === null ? Infinity : key === current ? -1 : all.find((s) => s.id === key).index);
      return [...groups.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .flatMap(([key, items]) => {
          const space = all.find((s) => s.id === key);
          const title = space ? `${label(space)}${key === current ? " (this one)" : ""}` : "No space";
          return [section(`${title} · ${items.length}`), ...items.map(row)];
        });
    };

    const header = h_flex().h(44).flex_none().px(14).items_center().gap(10).border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Human"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(open.length ? t.blocked : t.dim).child(this.loaded
        ? `${open.length ? `${open.length} to do${open.some((i) => i.wait) ? ` · ${open.filter((i) => i.wait).length} waiting` : ""}` : "nothing to do"}${!this.showAll && hidden ? ` · ${hidden} in other spaces` : ""}`
        : "Loading…"))
      .child(button("scope", this.showAll ? "All spaces" : "This space", (cx) => {
        this.showAll = !this.showAll;
        cx.notify();
      }, this.showAll))
      .when(done.length > 0, (el) => el.child(button("clear", "Clear", (cx) => this.clearDone(cx))))
      .when(Boolean(props()?.overlay), (el) =>
        el.child(div().id("close").flex_none().size(24).rounded(4).flex().items_center().justify_center().text_size(13).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click(() => closeOverlay(props().overlay)).child("✕")));

    let body;
    if (this.error) {
      body = div().p(12).text_size(12).text_color(t.ansi1).child(this.error);
    } else if (this.loaded && visible.length === 0) {
      body = div().p(14).text_size(13).text_color(t.dim).child("Nothing to do. Instructions from agents show up here.");
    } else {
      body = v_flex().id("human-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
        .when(open.length > 0, (el) => el.children(this.showAll ? grouped(open) : open.map(row)))
        .when(done.length > 0, (el) => el.child(section(`Done (${done.length})`)).children(done.map(row)));
    }

    // A window has the width and height from mod.json; a pane fills its block.
    return v_flex().size_full().bg(t.surface).child(header).child(body);
  }
}
