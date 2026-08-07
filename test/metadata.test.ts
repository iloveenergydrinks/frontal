import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NexusError } from "../src/errors.js";
import { uploadFlapMetadata } from "../src/flap-metadata.js";
import { normalizeTokenMetadata } from "../src/metadata.js";

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

afterEach(() => vi.unstubAllGlobals());

describe("token metadata", () => {
  it("normalizes text and HTTPS links", () => {
    const result = normalizeTokenMetadata({
      name: "  Nexus  ",
      symbol: " NXS ",
      socials: { website: "https://cli.nexus" },
    });
    expect(result.name).toBe("Nexus");
    expect(result.symbol).toBe("NXS");
    expect(result.socials.website).toBe("https://cli.nexus/");
  });

  it("rejects invisible controls and non-HTTPS social links", () => {
    expect(() => normalizeTokenMetadata({ name: "Nex\u200bus", symbol: "NXS" })).toThrowError(
      NexusError,
    );
    expect(() =>
      normalizeTokenMetadata({ name: "Nexus", symbol: "NXS", socials: { website: "http://cli.nexus" } }),
    ).toThrowError(/HTTPS/u);
  });

  it("uploads a 512px PNG and normalizes gateway CIDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-metadata-"));
    const imagePath = join(directory, "profile.png");
    await writeFile(imagePath, pngHeader(512, 512));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { create: "bafyMetadata" } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ image: "ipfs://bafyImage" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await uploadFlapMetadata({
        creator: "0x1111111111111111111111111111111111111111",
        description: "Nexus E2E",
        imagePath,
        website: "https://cli.nexus",
      });
      expect(result).toMatchObject({
        imageCid: "bafyImage",
        imageUri: "ipfs://bafyImage",
        metadataCid: "bafyMetadata",
        metadataUri: "ipfs://bafyMetadata",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a PNG with the wrong dimensions before upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-metadata-"));
    const imagePath = join(directory, "profile.png");
    await writeFile(imagePath, pngHeader(256, 256));
    try {
      await expect(
        uploadFlapMetadata({ creator: "0x1111111111111111111111111111111111111111", imagePath }),
      ).rejects.toThrowError(/512x512/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
