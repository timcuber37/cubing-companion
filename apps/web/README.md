# apps/web

Placeholder. The Next.js app lands with **A1** (smart cube link + virtual cube).

Nothing is installed here yet, deliberately — A0 is meant to be verifiable in CI with no
browser, no hardware, and a fast install.

When this is built out, note the boundary the workspace layout exists to enforce: the
BLE adapter is an *input adapter*, and `packages/analysis` must never import it. Smart
cube, pasted reconstruction, and file import all feed the same pipeline.
