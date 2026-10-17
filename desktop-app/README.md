# LMO 회의 인사이트 Desktop UI

## Active UI Path

The desktop renderer starts from `src/main.jsx` and renders `src/App.tsx`.

Use these project-local UI primitives for shared interface work:

- `src/components/common/` (`Button`, `IconButton`, `Input`, `StatusBanner`, `ProgressBar`, `AppToast`), listed in `src/components/common/index.ts`
- shared classes in `src/index.css`

Avoid adding a second UI kit unless the active entry path is changed deliberately.

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm build
```
