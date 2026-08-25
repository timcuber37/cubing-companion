import { CubeHarness } from "@/components/CubeHarness";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-neutral-100">
          Cubing Companion
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Connect a GAN cube or drive it by hand, then scramble and solve — every
          attempt is timed, segmented into CFOP phases, and kept.
        </p>
      </header>
      <CubeHarness />
    </main>
  );
}
