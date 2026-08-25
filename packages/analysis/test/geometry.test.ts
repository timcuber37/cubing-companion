/**
 * Geometry is derived from piece names rather than tabulated, so these tests check the
 * derivation rather than a table of constants — a wrong entry here would be invisible
 * everywhere else until the segmenter quietly mis-scored a colour nobody solves with.
 */
import { describe, expect, it } from "vitest";
import { CORNER_NAMES, EDGE_NAMES, Face } from "@cubing-companion/engine";
import {
  ALL_FACES,
  faceName,
  GEOMETRY,
  OPPOSITE,
  slotName,
} from "../src/geometry.ts";

describe("face relationships", () => {
  it("pairs every face with its opposite, symmetrically", () => {
    for (const face of ALL_FACES) {
      expect(OPPOSITE[OPPOSITE[face]!]).toBe(face);
      expect(OPPOSITE[face]).not.toBe(face);
    }
    expect(OPPOSITE[Face.U]).toBe(Face.D);
    expect(OPPOSITE[Face.L]).toBe(Face.R);
    expect(OPPOSITE[Face.F]).toBe(Face.B);
  });
});

describe("per-cross geometry", () => {
  it("exists for all six colours", () => {
    expect(GEOMETRY).toHaveLength(6);
    for (const face of ALL_FACES) {
      expect(GEOMETRY[face]!.crossFace).toBe(face);
    }
  });

  it("gives every cross four edges, four slots, and a last layer", () => {
    for (const geometry of GEOMETRY) {
      expect(geometry.crossEdges).toHaveLength(4);
      expect(geometry.slots).toHaveLength(4);
      expect(geometry.llCorners).toHaveLength(4);
      expect(geometry.llEdges).toHaveLength(4);
      // F2L is the cross layer plus the middle: 4 corners, 4 cross edges + 4 middle edges.
      expect(geometry.f2lCorners).toHaveLength(4);
      expect(geometry.f2lEdges).toHaveLength(8);
    }
  });

  it("partitions the cube: F2L and last layer share nothing and cover everything", () => {
    for (const geometry of GEOMETRY) {
      const corners = new Set([...geometry.f2lCorners, ...geometry.llCorners]);
      const edges = new Set([...geometry.f2lEdges, ...geometry.llEdges]);
      expect(corners.size).toBe(CORNER_NAMES.length);
      expect(edges.size).toBe(EDGE_NAMES.length);
    }
  });

  it("puts the cross edges inside F2L, and none of them in the last layer", () => {
    for (const geometry of GEOMETRY) {
      for (const edge of geometry.crossEdges) {
        expect(geometry.f2lEdges).toContain(edge);
        expect(geometry.llEdges).not.toContain(edge);
      }
    }
  });

  it("gives each slot a corner and edge that share both side faces", () => {
    for (const geometry of GEOMETRY) {
      const seenCorners = new Set<number>();
      const seenEdges = new Set<number>();
      for (const slot of geometry.slots) {
        seenCorners.add(slot.corner);
        seenEdges.add(slot.edge);
        const cornerFaces = [...CORNER_NAMES[slot.corner]!];
        const edgeFaces = [...EDGE_NAMES[slot.edge]!];
        for (const face of slot.faces) {
          expect(cornerFaces).toContain(faceName(face));
          expect(edgeFaces).toContain(faceName(face));
        }
        // The slot's edge belongs to the middle layer: it touches neither cross nor LL.
        expect(edgeFaces).not.toContain(faceName(geometry.crossFace));
        expect(edgeFaces).not.toContain(faceName(geometry.lastLayerFace));
      }
      expect(seenCorners.size).toBe(4);
      expect(seenEdges.size).toBe(4);
    }
  });

  it("matches the textbook D-cross layout", () => {
    // The familiar case, spelled out, so a derivation error is caught by inspection.
    const d = GEOMETRY[Face.D]!;
    expect(d.lastLayerFace).toBe(Face.U);
    expect(d.crossEdges.map((e) => EDGE_NAMES[e]).sort()).toEqual([
      "DB",
      "DF",
      "DL",
      "DR",
    ]);
    expect(d.slots.map(slotName).sort()).toEqual(["BL", "BR", "FL", "FR"]);
    expect(d.llCorners.map((c) => CORNER_NAMES[c]).sort()).toEqual([
      "UBR",
      "UFL",
      "ULB",
      "URF",
    ]);
  });
});
