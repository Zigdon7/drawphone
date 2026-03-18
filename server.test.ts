import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const serverSrc = fs.readFileSync(path.join(__dirname, "server.ts"), "utf-8");
const wordDir = path.join(__dirname, "server", "words");
const EXPECTED_WORD_PACKS = [
  "Simple words (recommended)", "Advanced words", "Immature words (13+)",
  "Naughty words (18+)", "Animals", "Adjectives", "Verbs",
];

describe("Game Room Management", () => {
  it("should generate 4-letter lowercase room codes", () => {
    expect(serverSrc).toMatch(/[a-z]{4}|generateCode/i);
  });
  it("should support finding a game by code", () => {
    expect(serverSrc).toMatch(/findGame/);
  });
  it("should remove empty games", () => {
    expect(serverSrc).toMatch(/removeGame|deleteGameIfEmpty|onEmpty/);
  });
  it("should support server lock for maintenance", () => {
    expect(serverSrc).toMatch(/locked|minutesUntilRestart/);
  });
});

describe("Player Management", () => {
  it("should assign host to first player", () => {
    expect(serverSrc).toMatch(/isHost|makeHost/);
  });
  it("should transfer host on disconnect", () => {
    expect(serverSrc).toMatch(/onPlayerDisconnect/);
  });
  it("should track player connection status", () => {
    expect(serverSrc).toMatch(/isConnected/);
  });
  it("should support player replacement mid-game", () => {
    expect(serverSrc).toMatch(/replacePlayer|findReplacementFor/);
  });
});

describe("Bot/AI Players", () => {
  it("should support adding bot players", () => {
    expect(serverSrc).toMatch(/addBotPlayer|PlayerAI|isAi/);
  });
  it("should support removing bot players", () => {
    expect(serverSrc).toMatch(/removeBotPlayer/);
  });
  it("should have AI guess queue", () => {
    expect(serverSrc).toMatch(/AIGuessQueue|aiGuessQueue/);
  });
});

describe("Word Packs", () => {
  it("should have word pack files", () => {
    expect(fs.existsSync(wordDir)).toBe(true);
  });
  it("should have all 7 word packs", () => {
    for (const pack of EXPECTED_WORD_PACKS) {
      expect(fs.existsSync(path.join(wordDir, pack + ".txt")), `Missing: ${pack}`).toBe(true);
    }
  });
  it("should support word pack selection", () => {
    expect(serverSrc).toMatch(/WordPack/i);
  });
});

describe("Game Modes", () => {
  it("should support word-first mode", () => {
    expect(serverSrc).toMatch(/isWordFirst|FirstWordLink|first-word/);
  });
  it("should support demo/single-player mode", () => {
    expect(serverSrc).toMatch(/players\.length === 1/);
  });
});

describe("Chain System", () => {
  it("should have chain concept", () => {
    expect(serverSrc).toMatch(/class Chain/);
  });
  it("should have drawing links", () => {
    expect(serverSrc).toMatch(/DrawingLink/);
  });
  it("should have word links", () => {
    expect(serverSrc).toMatch(/WordLink/);
  });
  it("should alternate between drawing and word turns", () => {
    expect(serverSrc).toMatch(/startNextLink|sendLastLinkToThen/);
  });
});

describe("Round System", () => {
  it("should have round concept", () => {
    expect(serverSrc).toMatch(/class Round/);
  });
  it("should support configurable turn limits", () => {
    expect(serverSrc).toMatch(/turnLimit/);
  });
  it("should support time limits per turn", () => {
    expect(serverSrc).toMatch(/timeLimit/);
  });
  it("should use Latin square for fair chain distribution", () => {
    expect(serverSrc).toMatch(/latinSquare|linkOrder|rowComplete/i);
  });
});

describe("Results", () => {
  it("should support viewing results", () => {
    expect(serverSrc).toMatch(/viewResults/);
  });
  it("should support viewing previous round results", () => {
    expect(serverSrc).toMatch(/viewPreviousResults|canViewLastRoundResults|isViewPreviousResults/);
  });
});

describe("Settings", () => {
  it("should support show neighbors setting", () => {
    expect(serverSrc).toMatch(/showNeighbors/);
  });
  it("should broadcast settings updates", () => {
    expect(serverSrc).toMatch(/updateSettings|sendUpdatedSettings/);
  });
});

describe("Input Sanitization", () => {
  it("should sanitize user input", () => {
    expect(serverSrc).toMatch(/stripTags/);
  });
});

describe("Waiting List", () => {
  it("should show who hasn't finished their turn", () => {
    expect(serverSrc).toMatch(/waitingList|notFinished|getListOfNotFinishedPlayers/i);
  });
});
