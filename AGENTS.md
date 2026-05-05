# Project Agent Notes

## Audio Performance Work

When changing audio preprocessing, STT quality, diarization quality, or long-file performance:

- Read `docs/audio-performance-improvement-log.md` before changing code.
- Update `docs/audio-performance-improvement-log.md` with lessons, failed attempts, and comparison results.
- Keep detailed experiments in the docs, not in this file.
- Do not make a preprocessing mode the default based on one sample.
- Compare STT quality, diarization impact, processing time, and failure risk together.
- Treat denoise and silence trimming as late-stage experiments because they can remove Korean consonants, endings, or quiet speech.

Related docs:

- `docs/audio-performance-improvement-log.md`
- `docs/audio-preprocessing-notes.md`
- `docs/audio-preprocessing-test-plan.md`
- `docs/audio-preprocessing-eval-template.csv`
- `todo.md`
