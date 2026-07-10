# Repository Guidelines

## Project Structure & Module Organization

This repository is a small GsCore plugin collection that depends on `XutheringWavesUID` for game data, APIs, and rendering helpers.

- `__init__.py`: registers `XWUIDCollection` and the default `ww` command prefix.
- `wwbingo/`: bingo handler, configuration, character metadata, Jinja template, and image assets.
- `wwncee/`: mock exam-score handler and its Jinja template.
- `README.md` and `ICON.png`: user documentation and plugin branding.

Add new features as self-contained subdirectories, keeping handlers, templates, and static assets together.

## Build, Test, and Development Commands

There is no standalone build system or dependency manifest. Runtime testing must occur inside a configured `gsuid-core` installation containing `XutheringWavesUID`.

- `python -m compileall .`: checks every Python file for syntax errors.
- `python -m compileall wwbingo wwncee`: runs a faster feature-level syntax check.
- `git diff --check`: detects trailing whitespace and malformed patch lines.

For functional checks, place this repository under the core's `plugins/` directory, start GsCore using the parent project's documented command, and exercise `ww宾果`, `ww高考`, and `wwgk`.

## Coding Style & Naming Conventions

Use four-space indentation and UTF-8 Python files. Group imports as standard library, third-party packages, `gsuid_core`, then local imports. Use `snake_case` for functions and variables, `UPPER_SNAKE_CASE` for constants, and descriptive `sv_<feature>` names for `SV` instances. Keep handlers asynchronous and await bot, database, HTTP, and rendering operations. Put HTML presentation in Jinja templates instead of large Python strings.

## Testing Guidelines

No automated test suite is included. Each change should pass `compileall` and be exercised in a live GsCore environment. Verify normal output, missing binding/configuration paths, rendering failures, and dependency/API errors. If tests are added, use `pytest`, store them in `tests/`, and name files `test_<feature>.py`.

## Commit & Pull Request Guidelines

Recent commits use short, feature-scoped Chinese summaries, such as `宾果: 底部统计不换行`. Follow `<模块>: <明确变更>` with an imperative or outcome-focused description. Pull requests should explain behavior changes, list manual commands tested, mention configuration changes, and include screenshots for HTML or image-rendering updates. Link related issues and note required GsCore or `XutheringWavesUID` versions.

## Security & Configuration Tips

Do not commit tokens, user IDs, generated data, or local IDE files. Runtime settings belong in `data/XWUIDCollection/config.json`; document new keys and provide safe defaults through the existing GsCore configuration models.
