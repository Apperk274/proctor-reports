# proctor-reports

Visual review reports for the development of Exam Supervisor Simulator, published with GitHub Pages at https://apperk274.github.io/proctor-reports/.

## How the site is laid out

- Each report lives in its own folder (for example `student-characters/`) with an `index.html` and its media in `img/`, `vid/` or `audio/`.
- `reports.json` is the single list of reports. The root `index.html` renders it in the browser: one column per category, newest first inside each, with the summary on hover (or behind the "i" button on touch screens). Never edit the index by hand.
- `history.json` is the change log: one entry per report per push. It is the only source of each report's "Updated" date and author on the index, and `history/` renders it as the History page.
- Pages are self-contained static HTML: relative paths only, every referenced file committed, no build step.

## Adding or updating a report

1. Put the page in a folder named after the report's slug: `<slug>/index.html` plus its media.
2. Add or update its entry in `reports.json`:
   - `slug`: the folder name.
   - `title`: the report's name, matching the page's `<title>` and `<h1>`.
   - `category`: the `id` of one of the listed `categories`. Add a new category only when none fits.
   - `summary`: one plain sentence (about 15–25 words) of what the report shows now.
3. Add a `history.json` entry for every report the push changes, at the top of the list:
   ```json
   {"date": "2026-10-28", "author": "Apperk274", "slug": "exam-bell-sounds", "change": "Added No. 15, the small gong at classic speed, now the bell in the game."}
   ```
   - `date`: today, as `YYYY-MM-DD`.
   - `author`: your `git config user.name`. Names only, never an email address: this repo is public.
   - `slug`: the report's slug, or `null` for a site-wide change (the index, the History page, this README, `check.mjs`).
   - `change`: one plain sentence about what changed.
   A push that changes several reports adds one entry per report. Never rewrite old entries; the history is append-only.
4. Every report page links back to the index with `<a class="back" href="../">← All reports</a>` as the first thing in its header, styled with the page's own tokens and a visible focus outline. Copy the `.back` rules from any existing report.
5. When a topic overlaps an existing report, extend that report instead of starting a near-duplicate.
6. A report describes the current state, not a log of updates. When something is superseded, replace it in the report rather than appending.

## Checking before you push

Run the check from the repo root after `git add`, and fix every `FAIL` before pushing:

```sh
node check.mjs
```

Node is pinned in `mise.toml` (`mise install` if it is missing). The check fails when a report folder has no manifest entry or an entry has no folder, when a manifest field is missing or a category is unknown, when a report page has no link back to `../`, when a `history.json` entry is malformed, names an unknown slug or is dated in the future, when a report has no history entry at all, when files in a report folder are staged but the staged `history.json` has no new entry for that report, and when a `src`/`href` (or a media path written as a string in a page script) does not resolve to a file tracked by git, including letter-case mismatches. It warns when the new history entry's author is not your `git config user.name`, and about media files no page references statically; that is expected for paths a script builds (the clips and clothes in `student-characters/`), otherwise delete the file.

## Never rename or move a published folder

Links to report folders are shared outside this repo. To retire or merge a report, move its content where it belongs, then replace the old folder's `index.html` with a small redirect stub (a meta refresh and a visible link to the new location), delete the old media and record it under `redirects` in `reports.json` with its old `title`, so its history entries still have a name. `whisper-comparison/` is an example.

## Public repo

This repo is public. Never commit secrets, API keys, save files or anything not meant for the public.
