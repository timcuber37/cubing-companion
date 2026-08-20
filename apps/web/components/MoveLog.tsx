"use client";

import { serializeMove, type Move } from "@cubing-companion/engine";
import type { TimedMove } from "@cubing-companion/cube-link";

/**
 * The move stream, newest first.
 *
 * Both clocks are shown deliberately. BLE batching is the thing most likely to surprise
 * you here — several turns arrive in one packet, and only the newest of them carries a host
 * timestamp — so the log makes that visible rather than leaving it to be inferred from odd
 * numbers later. The `via` column says how each timestamp was arrived at, which keeps the
 * display honest about its own precision.
 */
export function MoveLog({ moves }: { moves: TimedMove[] }) {
  return (
    <div className="rounded-md border border-neutral-800">
      <div className="flex items-baseline justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Moves
        </h2>
        <span className="text-xs text-neutral-600">{moves.length}</span>
      </div>

      {moves.length === 0 ? (
        <p className="px-3 py-4 text-sm text-neutral-600">
          Nothing yet. Turn the cube, or type into the manual input.
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-neutral-950 text-neutral-500">
              <tr>
                <th className="px-3 py-1 font-medium">Move</th>
                <th className="px-2 py-1 font-medium">Serial</th>
                <th className="px-2 py-1 font-medium">Δ ms</th>
                <th className="px-2 py-1 font-medium">Cube</th>
                <th className="px-2 py-1 font-medium">Host</th>
                <th className="px-2 py-1 font-medium">Via</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((move, index) => {
                // `moves` is newest-first, so the previous move in time is the next row.
                const earlier = moves[index + 1];
                const delta =
                  move.timestamp !== null && earlier?.timestamp != null
                    ? move.timestamp - earlier.timestamp
                    : null;
                return (
                  <tr
                    key={`${move.serial}-${index}`}
                    className="border-t border-neutral-900"
                  >
                    <td className="px-3 py-1 font-mono text-sm text-neutral-100">
                      {formatMove(move.move)}
                    </td>
                    <td className="px-2 py-1 text-neutral-500">{move.serial}</td>
                    <td className="px-2 py-1 text-neutral-300">
                      {delta === null ? "—" : Math.round(delta)}
                    </td>
                    <td className="px-2 py-1 text-neutral-500">
                      {move.cubeTimestamp === null
                        ? "—"
                        : Math.round(move.cubeTimestamp)}
                    </td>
                    <td
                      className={
                        move.localTimestamp === null
                          ? "px-2 py-1 text-amber-600"
                          : "px-2 py-1 text-neutral-500"
                      }
                      title={
                        move.localTimestamp === null
                          ? "Batched: this move shared a BLE packet, so it has no host timestamp of its own."
                          : undefined
                      }
                    >
                      {move.localTimestamp === null
                        ? "batched"
                        : Math.round(move.localTimestamp)}
                    </td>
                    <td className="px-2 py-1 text-neutral-600">
                      {move.timestampSource}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const formatMove = (move: Move): string => serializeMove(move);
