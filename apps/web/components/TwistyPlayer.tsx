"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { serializeMove, type CubeState, type Move } from "@cubing-companion/engine";

/**
 * What the rest of the app can do to the virtual cube.
 *
 * Deliberately small. Moves are pushed one at a time so each turn animates as it happens,
 * and the whole state is replaced outright after a desync — at which point the move history
 * is meaningless and only the position matters.
 */
export interface TwistyHandle {
  /** Animate a single move. */
  addMove(move: Move): void;
  /** Replace the cube's position wholesale, e.g. after a desync re-seed. */
  setState(state: CubeState): void;
  ready(): boolean;
}

/** The parts of `<twisty-player>` used here; it ships no React bindings. */
interface TwistyPlayerElement extends HTMLElement {
  experimentalAddMove(move: string): void;
  alg: string;
  experimentalModel: {
    setupTransformation: { set(value: unknown): void };
  };
}

export function TwistyPlayer({ ref }: { ref?: Ref<TwistyHandle> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<TwistyPlayerElement | null>(null);
  /**
   * Builds the `KTransformation` that puts the player into a given state.
   *
   * This works without a solver only because the engine adopted cubing.js's piece
   * indexing back in A0 — `cp`/`co`/`ep`/`eo` drop straight into a transformation, and
   * applying it to a solved cube reproduces the state exactly, rotations included.
   */
  const toTransformationRef = useRef<((state: CubeState) => unknown) | null>(null);
  /** Work that arrived before the player finished loading. */
  const pendingRef = useRef<{ moves: Move[]; state: CubeState | null }>({
    moves: [],
    state: null,
  });

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // `cubing/twisty` registers custom elements and touches `document` on import, so it
    // cannot run during server rendering. Importing here keeps it client-only and out of
    // the initial bundle.
    void (async () => {
      const [{ TwistyPlayer: Ctor }, { KTransformation }, { cube3x3x3 }] =
        await Promise.all([
          import("cubing/twisty"),
          import("cubing/kpuzzle"),
          import("cubing/puzzles"),
        ]);
      const kpuzzle = await cube3x3x3.kpuzzle();
      if (cancelled) return;

      toTransformationRef.current = (state: CubeState) =>
        new KTransformation(kpuzzle, {
          CORNERS: {
            permutation: [...state.cp],
            orientationDelta: [...state.co],
          },
          EDGES: { permutation: [...state.ep], orientationDelta: [...state.eo] },
          CENTERS: {
            permutation: [...state.centers],
            orientationDelta: [0, 0, 0, 0, 0, 0],
          },
        });

      const player = new Ctor({
        puzzle: "3x3x3",
        visualization: "PG3D",
        background: "none",
        controlPanel: "none",
        hintFacelets: "none",
      }) as unknown as TwistyPlayerElement;

      player.style.width = "100%";
      player.style.height = "100%";
      container.replaceChildren(player);
      playerRef.current = player;

      // Replay whatever happened while the module was loading, state first.
      const pending = pendingRef.current;
      if (pending.state) {
        player.experimentalModel.setupTransformation.set(
          toTransformationRef.current(pending.state),
        );
        player.alg = "";
        pending.state = null;
      }
      for (const move of pending.moves.splice(0)) {
        player.experimentalAddMove(serializeMove(move));
      }
    })();

    return () => {
      cancelled = true;
      playerRef.current = null;
      toTransformationRef.current = null;
      container.replaceChildren();
    };
  }, []);

  useImperativeHandle(
    ref,
    (): TwistyHandle => ({
      addMove(move) {
        const player = playerRef.current;
        if (!player) {
          pendingRef.current.moves.push(move);
          return;
        }
        player.experimentalAddMove(serializeMove(move));
      },
      setState(state) {
        const player = playerRef.current;
        const toTransformation = toTransformationRef.current;
        if (!player || !toTransformation) {
          pendingRef.current.state = state;
          pendingRef.current.moves.length = 0;
          return;
        }
        player.experimentalModel.setupTransformation.set(toTransformation(state));
        // Clear the animated history: after a re-seed those moves no longer describe how
        // the cube got here.
        player.alg = "";
      },
      ready() {
        return playerRef.current !== null;
      },
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className="aspect-square w-full rounded-lg border border-neutral-800 bg-neutral-900"
      aria-label="Virtual cube"
    />
  );
}
