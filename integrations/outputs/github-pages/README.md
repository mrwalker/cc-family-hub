# GitHub Pages Output Integration

Writes the weekly family plan directly to a local clone of a separate portal
repo, commits, and pushes. GitHub Pages serves the result at a stable URL.
Family data stays out of `cc-family-hub` — the tool repo stays clean and
shareable with other families.

```
cc-family-hub/              ← this repo (public tool, no family data)
  integrations/
    outputs/
      github-pages/         ← this integration

walker-family-hub/          ← your private portal repo (peer directory)
  index.html                ← portal app (seeded once by setup:portal)
  public/data/
    plan-data.js            ← overwritten on every plan run
```

## Setup

### 1. Create your portal repo on GitHub

Create a new **private** repo (e.g. `walker-family-hub`) and clone it locally,
peer to `cc-family-hub`. It just needs to exist as a git repo — `setup:portal`
handles the rest.

### 2. Add config to `workspace/state/secrets.yaml`

```yaml
github-pages:
  repoPath: "/absolute/path/to/walker-family-hub"
```

### 3. Run setup (once)

```bash
npm run setup:portal
```

This copies `outputs/web-portal/index.html` into the portal repo, writes a
placeholder `public/data/plan-data.js`, commits, and pushes.

### 4. Enable GitHub Pages in GitHub

GitHub repo → Settings → Pages → Source: **Deploy from branch** → `main` / `(root)`

> **Note:** GitHub Pages on private repos requires **GitHub Pro** or higher.
> Free accounts can only serve Pages from public repos.

### 5. Enable the integration in `workspace/family.yaml`

```yaml
integrations:
  active:
    - google-calendar
    - web-portal
    - github-pages    # ← add this
```

### 6. Run the planner

```bash
npm run plan
```

Every plan run writes updated `plan-data.js` to the portal repo, commits, and
pushes. GitHub Pages deploys within seconds.

## Configuration

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `repoPath` | yes | — | Absolute path to the local portal repo |
| `autoPush` | no | `true` | Set `false` to commit locally without pushing |

## Updating the portal HTML

If you modify `outputs/web-portal/index.html` in `cc-family-hub`, re-run
setup to push the update:

```bash
npm run setup:portal
```
