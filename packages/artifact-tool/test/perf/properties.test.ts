import { describe, expect, test } from "bun:test";

import { ArtifactCommandBatchCodec, type ArtifactCommandBatch } from "../../src/kernel";
import { Presentation } from "../../src/presentation";
import { Workbook } from "../../src/spreadsheet";
import { random } from "../../bench/support";

describe("artifact deterministic properties", () => {
  test("random sparse writes agree with an independent map and survive snapshots", () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const next = random(seed);
      const workbook = Workbook.create();
      const sheet = workbook.worksheets.add("Sparse");
      const expected = new Map<string, number>();
      workbook.transact(() => {
        for (let index = 0; index < 400; index += 1) {
          const row = Math.floor(next() * 1_000_000);
          const col = Math.floor(next() * 64);
          const value = Math.floor(next() * 1_000_000);
          sheet.getCell(row, col).values = [[value]];
          expected.set(`${row}:${col}`, value);
        }
      });

      const restored = Workbook.fromJSON(JSON.parse(JSON.stringify(workbook.toJSON())));
      const restoredSheet = restored.worksheets.getActiveWorksheet();
      expect([...restoredSheet.cellEntries()].length).toBe(expected.size);
      for (const [key, value] of expected) {
        const [row, col] = key.split(":").map(Number) as [number, number];
        expect(restoredSheet.getCell(row, col).values).toEqual([[value]]);
      }
      expect(restored.toJSON()).toEqual(workbook.toJSON());
    }
  }, 20_000);

  test("random acyclic formula graphs calculate against a scalar oracle", () => {
    for (let seed = 1; seed <= 48; seed += 1) {
      const next = random(seed ^ 0x9e3779b9);
      const workbook = Workbook.create();
      const sheet = workbook.worksheets.add("Formula");
      const expected: number[] = [];
      const formulas: string[][] = [];
      for (let row = 0; row < 128; row += 1) {
        if (row === 0) {
          const value = Math.floor(next() * 100);
          sheet.getRange("A1").values = [[value]];
          expected.push(value);
          formulas.push([""]);
          continue;
        }
        const parent = Math.floor(next() * row);
        const addend = Math.floor(next() * 21) - 10;
        formulas.push([`=A${parent + 1}+${addend}`]);
        expected.push(expected[parent]! + addend);
      }
      sheet.getRange("A2:A128").formulas = formulas.slice(1);
      workbook.recalculate();
      expect(sheet.getRange("A1:A128").values.flat()).toEqual(expected);
    }
  }, 20_000);

  test("random command batches have one canonical binary encoding", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const next = random(seed ^ 0xa5a5a5a5);
      const commands = Array.from({ length: 1 + Math.floor(next() * 20) }, (_, index) => ({
        code: index % 2 === 0 ? "sheet.set" : "shape.move",
        targetId: `object-${Math.floor(next() * 40)}`,
        precondition: { objectRevision: Math.floor(next() * 100), exists: next() > 0.2 },
        payload: {
          row: Math.floor(next() * 1_000_000),
          value: Math.floor(next() * 100_000),
          enabled: next() > 0.5,
        },
      }));
      const batch: ArtifactCommandBatch = {
        schemaVersion: 1,
        artifactId: `artifact-${seed}`,
        modality: seed % 3 === 0 ? "document" : seed % 2 === 0 ? "presentation" : "spreadsheet",
        transactionId: `transaction-${seed}`,
        actorId: `actor-${seed % 7}`,
        baseSequence: seed * 3,
        baseVector: { z: seed, a: seed + 1 },
        commands,
      };
      const first = ArtifactCommandBatchCodec.encode(batch);
      const decoded = ArtifactCommandBatchCodec.decode(first);
      const second = ArtifactCommandBatchCodec.encode(decoded);
      expect(second).toEqual(first);
      expect(decoded).toEqual(batch);
    }
  });

  test("arbitrary operation bytes are bounded and canonical when accepted", () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const next = random(seed ^ 0x7f4a7c15);
      const bytes = Uint8Array.from({ length: Math.floor(next() * 512) }, () =>
        Math.floor(next() * 256),
      );
      try {
        const decoded = ArtifactCommandBatchCodec.decode(bytes);
        const canonical = ArtifactCommandBatchCodec.encode(decoded);
        expect(ArtifactCommandBatchCodec.decode(canonical)).toEqual(decoded);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  test("spreadsheet SVG and PNG renders are byte deterministic", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Visual");
    sheet.getRange("A1:C3").values = [
      ["α", "مرحبا", "😀"],
      [1, 2, 3],
      [true, false, null],
    ];
    sheet.getRange("A1:C1").format = { font: { bold: true }, fill: "#e2e8f0" };

    const firstSvg = await workbook.render({ format: "svg", range: "A1:C3", scale: 2 });
    const secondSvg = await workbook.render({ format: "svg", range: "A1:C3", scale: 2 });
    expect(await secondSvg.text()).toBe(await firstSvg.text());

    const firstPng = new Uint8Array(
      await (await workbook.render({ format: "png", range: "A1:C3", scale: 2 })).arrayBuffer(),
    );
    const secondPng = new Uint8Array(
      await (await workbook.render({ format: "png", range: "A1:C3", scale: 2 })).arrayBuffer(),
    );
    expect(secondPng).toEqual(firstPng);
  }, 15_000);

  test("500-slide layout is stable and every object id is unique", () => {
    const presentation = Presentation.create();
    const ids = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const slide = presentation.slides.add();
      ids.add(slide.id);
      ids.add(
        slide.shapes.add({
          geometry: "textbox",
          text: `Slide ${index}`,
          position: { left: 72, top: 72, width: 640, height: 80 },
        }).id,
      );
    }
    expect(ids.size).toBe(1_000);
    const first = JSON.stringify(presentation.layoutSnapshot());
    const second = JSON.stringify(presentation.layoutSnapshot());
    expect(second).toBe(first);
  });
});
