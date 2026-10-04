# CalSpread backend workflow

Follow `/home/prakash/Work/WORKFLOW.md`. The application source lives in `src/`;
the paired frontend is `../Cal_Spread/`. Build with `npm run build`; tests import
the checked `dist/` output. Keep analytics off execution paths and use the active
broker's providers, subscription coordinator and existing admin role validation.
Do not deploy or arm live execution as part of analytics work.

Current cross-repository task: `tasks/2026-10-03-fair-value/`.
