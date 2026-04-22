# AGENTS.md

## Release flow

When finishing a change in this repo, use this flow unless the user asks for something else.

1. Run typecheck.

```bash
npm run typecheck
```

2. Bump the package version.

- Patch release:

```bash
npm version patch --no-git-tag-version
```

- Minor release:

```bash
npm version minor --no-git-tag-version
```

- Major release:

```bash
npm version major --no-git-tag-version
```

This updates both `package.json` and `package-lock.json` without creating a git tag automatically.

3. Run typecheck again after the version bump.

```bash
npm run typecheck
```

4. Stage only the intended tracked files.

Example:

```bash
git add package.json package-lock.json src/...
```

5. Commit and push to `main`.

```bash
git commit -m "<clear message>"
git push origin main
```

## npm publish flow

After the commit is pushed:

```bash
npm whoami
npm publish
```

If the user wants a git tag too, create and push it explicitly:

```bash
git tag v<version>
git push origin v<version>
```

Example for `0.1.3`:

```bash
git tag v0.1.3
git push origin v0.1.3
```

## Quick one-shot flow

For a normal patch release:

```bash
npm run typecheck \
  && npm version patch --no-git-tag-version \
  && npm run typecheck \
  && git add package.json package-lock.json src/ \
  && git commit -m "<clear message>" \
  && git push origin main
```

Then:

```bash
npm publish
```

## Guardrails

- Prefer explicit `git add` paths over `git add .`.
- Run `npm run typecheck` before commit.
- If publishing, make sure the version in `package.json` is already bumped first.
