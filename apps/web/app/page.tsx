import { CubeHarness } from "@/components/CubeHarness";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-neutral-100">
          Smart cube link
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Track A1 — connect a GAN cube, or drive the virtual one by hand.
        </p>
      </header>
      <CubeHarness />
    </main>
  );
}
