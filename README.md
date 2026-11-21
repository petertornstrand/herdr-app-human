# Herdr Human

A [Herdr app](https://herdr.dev) mod that collects what your agents ask *you* to do into one
checklist. Agents register an instruction with `human-add`; you tick it off in a panel, copy
its command with a click, or reject it so the agent tries to do it itself.

- One inbox for every space and tab. The header button narrows the list to the shown space.
- Click an instruction (or its command) to copy the command, or the text if it has none.
- Tick the box to check it off. Checked items move under *Klara* and can be cleared.
- **Avvisa** sends the task back to the agent that created it (`hc send`). The agent is told
  to do it itself, and to register it again with `--retry '<why not>'` only if it can't.
  A retried item shows the agent's reason and has no reject button.
- An agent that can't continue until you're done registers the item with `--wait`. The card
  gets a red border and an "Agenten väntar på dig" pill, the header counts how many wait,
  and checking the item off sends `Done by the human: ...` to the agent's terminal, so it
  can end its turn and wake up when you're done. Without `--wait` the agent gets no signal.
- Checked items fold their command away.

The panel text is in Swedish (`Avvisa`, `Kopiera`, `Ta bort`, `Rensa klara`); change the
strings in `mods/human/main.js` if you want another language.

## How it works

Agents append one JSON line per instruction to `~/.config/herdr-app/human/inbox.jsonl`:

```json
{"id":"1795284398-9d7985ab","ts":"2026-11-21T19:00:00+01:00","project":"my-site","text":"Clear the cache","cmd":"ddev drush cr","terminal":"t7"}
```

The mod never edits that file. What you have checked off or removed is kept in
`~/.config/herdr-app/human/state.json`, so parallel agents can append without clashing.
`terminal` is the agent's `HC_TERMINAL_ID`; it is how *Avvisa* finds the agent.

## Install

Needs the Herdr desktop app, `jq` for `human-add`, and `wl-copy`, `xclip` or `xsel` for
copying.

```sh
git clone https://github.com/petertornstrand/herdr-app-human
cp -r herdr-app-human/mods/human ~/.config/herdr-app/mods/human
install -m 755 herdr-app-human/bin/human-add ~/.local/bin/human-add
herdr-app check ~/.config/herdr-app/mods/human
```

Open it as a popup with `mod.open:human`, or as a side pane with
`herdr-app do pane.split --direction right --mod human`.

## A button and a column in your layout

Herdr's own layouts and tab bar are read-only, so clone them first
(`herdr-app do layout.clone '{"name":"main","as":"my-layout"}'` and
`herdr-app do mod.clone '{"name":"tabs","as":"my-tabs"}'`), point the layout's `tabs` block at
the cloned tab bar, then:

1. In the layout, add a hidden block as a sibling of the `panel` column inside `work-body`:

   ```json
   {
     "id": "human-panel",
     "type": "block",
     "hidden": true,
     "size": { "px": 360 },
     "min": 280,
     "max": 700,
     "content": { "mod": "human" }
   }
   ```

2. In the cloned tab bar, add a button after the panel buttons. It needs `find` (the
   tab bar's helper that looks up a layout node by id) and `run` from `herdr`:

   ```js
   .child((() => {
     const hp = find(root, "human-panel");
     const on = hp && !hp.hidden;
     return h_flex().id("panel-human").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
       .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
       .hover(s => s.bg(t.hover))
       .on_click(() => run(on ? "layout.hide" : "layout.show", { id: "human-panel" }))
       .child(svg("mods/human/icon.svg").size(14)).child("Human");
   })())
   ```

The exact variable names depend on the tab bar you cloned; read it and adapt.

## Tell your agents

`human-add [--project NAME] [--cmd 'command to copy'] [--retry 'why the agent could not do it'] [--wait] 'text'`

Add something like this to the instructions your agents read (`CLAUDE.md`, `AGENTS.md`):

```markdown
## Instructions to the human

Whenever you tell me to do something myself (run a command, check something in a browser,
change something on a server, reply to someone), also register it with `human-add` so it
shows up in the Human panel in Herdr. Do this in addition to writing it in chat.

- One call per separate action:
  `human-add --project <project> --cmd '<command>' '<short instruction>'`.
  `--cmd` is only for something I can copy and run as is.
- Keep the text to one line. Don't register things you only tell me for information.
- Add `--wait` only when you cannot continue until I've done it. Then end your turn; a
  message "Done by the human: ..." arrives in your terminal when I check it off. Without
  `--wait` you get no signal.
- Never check items off yourself. Only I do that, in the panel.
- If you can do the thing yourself, do it instead of registering it.
- If I reject an item, a message arrives in your terminal: "Rejected by the human: ...".
  Try to do it yourself. Only if you cannot, register it again with
  `human-add --retry '<why you could not>' '<text>'`.
```

## Limits

- *Avvisa* and the `--wait` signal only reach an agent whose terminal is still running. If
  it is gone, a notification says so; a rejected item then stays in the list.
- An item whose terminal is closed or unknown is shown in every space, so nothing is lost.
- The mod has been tried on Linux. On macOS, copying needs `pbcopy` added to `copyText()`.

## License

MIT
