// Is there a newer Human? At most once a day one Human reads the version in the
// repository's mod.json (one small GET to GitHub, nothing sent but the request)
// and every copy shares the answer in shared state. Updating is left to the
// person's agent (see updatePrompt): it reads the new files before it puts
// them in, as Herdr has agents do for any mod.
//
//   herdr-app do human.update-check-off   never ask GitHub again
//   herdr-app do human.update-check-on    ask again (and now)

import { appHome, readTextFile, shared, setShared } from "herdr";

export const REPO = "petertornstrand/herdr-app-human";
const REMOTE = `https://raw.githubusercontent.com/${REPO}/main/mods/human/mod.json`;
const KEY = "human.update";
const DAY = 86400000, HOUR = 3600000;

const slashes = (p) => String(p).replace(/\\/g, "/");

/** a > b, comparing dotted numbers ("0.10.0" > "0.9.2"); junk is never newer. */
export function newer(a, b) {
  const pa = String(a ?? "").split("."), pb = String(b ?? "").split(".");
  if (!pa.every((x) => /^\d+$/.test(x)) || !pb.every((x) => /^\d+$/.test(x))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** This copy's version, from its own mod.json. */
export async function installedVersion() {
  try {
    const text = await readTextFile(`${slashes(appHome())}/mods/human/mod.json`);
    return JSON.parse(text ?? "{}").version ?? null;
  } catch (_) {
    return null;
  }
}

/** The shared answer: { checked, latest, off }. Asks GitHub when a day old. */
export async function checkUpdate(now = Date.now()) {
  const known = shared(KEY) ?? {};
  if (!REMOTE || known.off || now - (known.checked ?? 0) < DAY) return known;
  // Marked as checked first, so other copies starting now don't ask too.
  setShared(KEY, { ...known, checked: now });
  // Why the last check failed stays in `error` (shared state, key human.update).
  try {
    const res = await fetch(REMOTE);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = (await res.json())?.version ?? null;
    const next = { ...known, checked: now, latest, error: null };
    setShared(KEY, next);
    return next;
  } catch (err) {
    // A failed request is asked again in an hour, not a day.
    const next = { ...known, checked: now - DAY + HOUR, error: String(err?.message ?? err) };
    setShared(KEY, next);
    return next;
  }
}

export function setUpdateCheck(on) {
  const known = shared(KEY) ?? {};
  setShared(KEY, on ? { ...known, off: false, checked: 0 } : { ...known, off: true });
}

/** What the agent is asked when the person clicks the update button. */
export function updatePrompt(latest, current) {
  const home = slashes(appHome());
  return `Update the Human mod of this Herdr app to ${latest} (installed: ${current ?? "unknown"}). Read ${home}/AGENTS.md first. Then replace the files in ${home}/mods/human with those in mods/human/ of https://github.com/${REPO} (branch main): it is the same mod, so overwrite it rather than adding a renamed copy, and leave keys.json and the layouts as they are. Also replace the human-add script (\`command -v human-add\`) with bin/human-add from the same repository and keep it executable, and install bin/human-remove next to it the same way. Run \`herdr-app check ${home}/mods/human\`, then tell me in a few lines what changed since ${current ?? "the installed version"} (the commit history of the repository says).`;
}
