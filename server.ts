import express from "express";
import { Server, Socket } from "socket.io";
import http from "http";
import path from "path";
import fs from "fs";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ============================================================
// Types
// ============================================================

interface PlayerJson {
  name: string;
  id: number;
  isHost: boolean;
  isConnected: boolean;
  isAi: boolean;
}

type LinkType = "word" | "drawing" | "first-word";

interface LinkData {
  player: PlayerJson;
  data: any;
  type: LinkType;
}

interface ChainJson {
  owner: PlayerJson;
  links: LinkData[];
  id: number;
}

// ============================================================
// Sanitization — strip HTML tags from user input
// ============================================================

function stripTags(str: string): string {
  return str.replace(/<[^>]*>/g, "");
}

// ============================================================
// Word Packs
// ============================================================

const WORD_PACK_NAMES = [
  "Simple words (recommended)",
  "Advanced words",
  "Immature words (13+)",
  "Naughty words (18+)",
  "Animals",
  "Adjectives",
  "Verbs",
];

class WordPacks {
  private packs: Map<string, string[]> = new Map();

  loadAll() {
    const wordDir = path.join(__dirname, "server", "words");
    for (const packName of WORD_PACK_NAMES) {
      const filePath = path.join(wordDir, packName + ".txt");
      if (fs.existsSync(filePath)) {
        const words = fs
          .readFileSync(filePath, "utf-8")
          .split(/\r?\n/)
          .map((w) => w.trim())
          .filter((w) => w !== "");
        this.packs.set(packName, words);
      }
    }
  }

  getRandomWord(packName: string): string {
    const pack = this.packs.get(packName);
    if (pack && pack.length > 0) {
      return pack[Math.floor(Math.random() * pack.length)];
    }
    const fallback = this.packs.get("Simple words (recommended)");
    if (fallback && fallback.length > 0) {
      return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return "cat";
  }
}

const wordPacks = new WordPacks();
wordPacks.loadAll();

// ============================================================
// Turn Limit Utility (from shared/util.js)
// ============================================================

function getNewTurnLimit({
  modifier,
  prevTurnLimit,
  numPlayers,
  prevNumPlayers,
  isWordFirst,
}: {
  modifier: number;
  prevTurnLimit: number;
  numPlayers: number;
  prevNumPlayers?: number;
  isWordFirst: boolean;
}) {
  prevNumPlayers = prevNumPlayers ?? numPlayers;
  const offset = isWordFirst ? 1 : 0;
  const minTurns = 4 - offset;
  const maxTurns = Math.floor((numPlayers + offset) / 2) * 2 - offset;

  if (!prevTurnLimit) {
    return { newTurnLimit: minTurns, isMax: true, isTurnLimitUnchanged: false };
  }

  const isValidWordFirstTurnLimit = prevTurnLimit % 2 === 1;
  let rawTurns = prevTurnLimit + modifier * 2;

  if (isValidWordFirstTurnLimit && !isWordFirst) rawTurns++;
  else if (!isValidWordFirstTurnLimit && isWordFirst) rawTurns--;

  const prevTurnLimitWasMax =
    numPlayers !== prevNumPlayers &&
    modifier === 0 &&
    numPlayers - prevTurnLimit <= 2;

  const newTurnLimit = Math.max(
    minTurns,
    prevTurnLimitWasMax ? maxTurns : Math.min(maxTurns, rawTurns)
  );

  return {
    newTurnLimit,
    isMax: newTurnLimit === maxTurns,
    isTurnLimitUnchanged: newTurnLimit === prevTurnLimit,
  };
}

// ============================================================
// Row-Complete Latin Square (fair chain distribution)
// ============================================================

const arrayFromOneToN = (length: number, offset = 0) =>
  Array.from({ length }, (_, i) => i + offset);

const rotateArray = (arr: number[], count = 1) => [
  ...arr.slice(count, arr.length),
  ...arr.slice(0, count),
];

function oddApproxRCLS(numPlayers: number, numTurns: number): number[][] {
  const m = (numPlayers - 1) / 2;
  let result: number[][] = [arrayFromOneToN(numPlayers)];
  const last = () => result[result.length - 1];

  for (let i = 1; i <= m; i++) {
    const direction = i % 2 === 0 ? -1 : 1;
    result.push(rotateArray(last(), i * direction));
  }

  const mDirection = m % 2 === 0 ? -1 : 1;
  result.push(rotateArray(last(), mDirection));

  for (let i = m - 1; i >= Math.max(1, m - numTurns); i--) {
    const direction = i % 2 === 0 ? 1 : -1;
    result.push(rotateArray(last(), i * direction));
  }
  return result;
}

function evenExactRCLS(numPlayers: number, numTurns: number): number[][] {
  let result: number[][] = [arrayFromOneToN(numPlayers)];
  const last = () => result[result.length - 1];

  for (let i = 1; i < numTurns; i++) {
    const direction = i % 2 === 0 ? -1 : 1;
    result.push(rotateArray(last(), i * direction));
  }
  return result;
}

function rowCompleteLatinSquare(numPlayers: number, numTurns: number): number[][] {
  return numPlayers % 2 === 0
    ? evenExactRCLS(numPlayers, numTurns)
    : oddApproxRCLS(numPlayers, numTurns);
}

// ============================================================
// AI Guess Queue
// ============================================================

class AIGuessQueue {
  private workQueue: any[] = [];
  private workerQueue: Player[] = [];
  private getRandomWordFn: () => string;

  constructor(getRandomWordFn: () => string) {
    this.getRandomWordFn = getRandomWordFn;
  }

  getRandomWord(): string {
    return this.getRandomWordFn();
  }

  addWork(work: { drawingToGuess: any; next: Function; attempts?: number }) {
    this.workQueue.push(work);
    this.distributeWork();
  }

  playerAvailableForWork(player: Player) {
    if (player.isAi) return;
    if (this.workerQueue.indexOf(player) === -1) this.workerQueue.push(player);
    this.distributeWork();
  }

  distributeWork() {
    while (this.workQueue.length > 0 && this.workerQueue.length > 0) {
      const { drawingToGuess, next, attempts = 0 } = this.workQueue.shift()!;
      if (attempts < 3) {
        const nextPlayer = this.workerQueue.shift()!;
        nextPlayer.sendThen(
          "makeAIGuess",
          drawingToGuess,
          "AIGuessResult",
          (res: any) => {
            if (res.success) {
              next(res);
            } else {
              this.addWork({ drawingToGuess, next, attempts: attempts + 1 });
            }
            this.playerAvailableForWork(nextPlayer);
          }
        );
      } else {
        next({ link: { type: "word", data: this.getRandomWordFn() } });
      }
    }
  }

  reset() {
    this.workQueue = [];
    this.workerQueue = [];
  }
}

// ============================================================
// Link Classes
// ============================================================

class Link {
  player: PlayerJson;
  data: any;
  type!: LinkType;

  constructor(player: Player, data: any) {
    this.player = player.getJson();
    this.data = data;
  }
}

class DrawingLink extends Link {
  constructor(player: Player, drawing: any) {
    super(player, drawing);
    this.type = "drawing";
  }
}

class WordLink extends Link {
  constructor(player: Player, word: string) {
    super(player, word);
    this.type = "word";
  }
}

class FirstWordLink extends Link {
  constructor(player: Player) {
    super(player, false);
    this.type = "first-word";
  }
}

// ============================================================
// Chain
// ============================================================

class Chain {
  owner: Player;
  links: Link[] = [];
  id: number;
  timeLimit: number;
  showNeighbors: boolean;
  playerList: PlayerJson[] | null;
  lastPlayerSentTo: PlayerJson;

  constructor(
    firstWord: string | false,
    owner: Player,
    id: number,
    timeLimit: number,
    showNeighbors: boolean,
    playerList: PlayerJson[] | null
  ) {
    this.owner = owner;
    this.id = id;
    this.timeLimit = timeLimit;
    this.showNeighbors = showNeighbors;
    this.playerList = playerList;
    this.lastPlayerSentTo = owner.getJson();

    if (!firstWord) {
      this.addLink(new FirstWordLink(this.owner));
    } else {
      this.addLink(new WordLink(this.owner, firstWord));
    }
  }

  addLink(link: Link) {
    this.links.push(link);
  }

  getLastLink(): Link {
    return this.links[this.links.length - 1];
  }

  getLength(): number {
    if (this.links[0] && this.links[0].type === "first-word") {
      return this.links.length - 1;
    }
    return this.links.length;
  }

  sendLastLinkToThen(player: Player, finalCount: number, next: Function) {
    let count = this.getLength();
    if (this.links[0] && this.links[0].type === "first-word") {
      count++;
    } else {
      finalCount--;
    }
    player.sendThen(
      "nextLink",
      {
        link: this.getLastLink(),
        chainId: this.id,
        count,
        finalCount,
        timeLimit: this.timeLimit,
        showNeighbors: this.showNeighbors,
        players: this.showNeighbors ? this.playerList : null,
        thisPlayer: player.getJson(),
      },
      "finishedLink",
      next
    );
  }

  getJson(): ChainJson {
    return {
      owner: this.owner.getJson(),
      links: this.links,
      id: this.id,
    };
  }
}

// ============================================================
// Player
// ============================================================

class Player {
  name: string;
  socket: Socket | any;
  id: number;
  isHost: boolean = false;
  isConnected: boolean = true;
  isAi: boolean = false;

  constructor(name: string, socket: Socket | any, id: number) {
    this.name = name;
    this.socket = socket;
    this.id = id;
  }

  getJson(): PlayerJson {
    return {
      name: this.name,
      id: this.id,
      isHost: this.isHost,
      isConnected: this.isConnected,
      isAi: this.isAi,
    };
  }

  send(event: string, data: any) {
    this.socket.emit(event, { you: this.getJson(), data });
  }

  sendThen(event: string, data: any, onEvent: string, next: Function) {
    this.socket.once(onEvent, next);
    this.send(event, data);
  }

  makeHost() {
    this.isHost = true;
    this.socket.emit("hostUpdatedSettings");
  }
}

// ============================================================
// PlayerAI (Bot)
// ============================================================

const BOT_NAMES = [
  "🤖 Garry-bot", "🤖 Jerry-bot", "🤖 Larry-bot", "🤖 Terry-bot",
  "🤖 Barry-bot", "🤖 Mary-bot", "🤖 Fairy-bot", "🤖 Sperry-bot",
  "🤖 Carrie-bot", "🤖 Dairy-bot", "🤖 Hairy-bot", "🤖 Airy-bot",
  "🤖 Perry-bot", "🤖 Query-bot", "🤖 Very-bot", "🤖 Cherry-bot",
  "🤖 Prairie-bot", "🤖 Scary-bot",
];

class PlayerAI extends Player {
  isAi = true;
  private lastCallback: Function | null = null;
  private aiGuessQueue: AIGuessQueue | null = null;

  constructor(name: string, socket: any, id: number) {
    super(name, {}, id);
    this.isAi = true;
    this.socket = {
      once: this._once.bind(this),
      emit: this._emit.bind(this),
      disconnect: () => {},
      on: () => {},
    };
  }

  _once(event: string, callback: Function) {
    if (event === "finishedLink") {
      this.lastCallback = callback;
    }
  }

  async _emit(event: string, data: any) {
    if (event !== "nextLink") return;
    const linkContent = data?.data?.link?.data;
    const linkType = data?.data?.link?.type;

    if (linkType === "word") {
      const image = "https://picsum.photos/seed/" + Math.random().toString(36).slice(2) + "/500/500";
      if (this.lastCallback) this.lastCallback({ link: { data: image, type: "drawing" } });
    } else if (linkType === "drawing") {
      if (this.aiGuessQueue) {
        this.aiGuessQueue.addWork({
          drawingToGuess: linkContent,
          next: this.lastCallback!,
        });
      }
    } else if (linkType === "first-word") {
      if (this.lastCallback && this.aiGuessQueue) {
        this.lastCallback({ link: { data: this.aiGuessQueue.getRandomWord(), type: "word" } });
      }
    }
  }

  setAIGuessQueue(aiGuessQueue: AIGuessQueue) {
    this.aiGuessQueue = aiGuessQueue;
  }
}

// ============================================================
// Round
// ============================================================

function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Round {
  number: number;
  players: Player[];
  timeLimit: number;
  wordPackName: string | null;
  showNeighbors: boolean;
  onResults: () => void;
  chains: Chain[] = [];
  linkOrder: number[][] = [];
  roundNumber: number = 0;
  disconnectedPlayers: PlayerJson[] = [];
  potentialPlayers: Player[] = [];
  canViewLastRoundResults: boolean = false;
  isWordFirstGame: boolean;
  turnLimit: number;
  shouldHaveThisManyLinks: number;
  finalNumOfLinks!: number;
  startTime!: number;
  aiGuessQueue: AIGuessQueue;

  constructor(
    number: number,
    players: Player[],
    timeLimit: number,
    wordPackName: string | null,
    showNeighbors: boolean,
    turnLimit: number,
    onResults: () => void
  ) {
    this.number = number;
    this.players = players;
    this.timeLimit = timeLimit;
    this.wordPackName = wordPackName;
    this.showNeighbors = showNeighbors;
    this.onResults = onResults;
    this.isWordFirstGame = !this.wordPackName;
    this.turnLimit = this.validTurnLimit(turnLimit);
    this.shouldHaveThisManyLinks = this.isWordFirstGame ? 1 : 2;
    this.aiGuessQueue = new AIGuessQueue(() =>
      wordPacks.getRandomWord(this.wordPackName || "Simple words (recommended)")
    );
  }

  start() {
    this.aiGuessQueue.reset();

    // Demo mode: single player
    if (this.players.length === 1) {
      this.finalNumOfLinks = 6;
    } else {
      this.finalNumOfLinks = this.turnLimit;
    }

    if (!this.isWordFirstGame) {
      this.finalNumOfLinks++;
    }

    // Ensure chains always end on a word
    if (this.finalNumOfLinks % 2 === 0) {
      this.finalNumOfLinks--;
    }

    shuffleArray(this.players);

    if (!this.isWordFirstGame) {
      this.sendNewChains();
    } else {
      this.sendWordFirstChains();
    }

    if (this.players.length === 1) {
      this.linkOrder = [[0], [0], [0], [0], [0], [0]];
    } else {
      this.linkOrder = rowCompleteLatinSquare(
        this.players.length,
        this.finalNumOfLinks
      );
    }

    this.startTime = Date.now();
  }

  sendNewChains() {
    let currentChainId = 0;
    const jsonPlayers = this.showNeighbors
      ? this.players.map((p) => p.getJson())
      : null;

    this.players.forEach((player) => {
      if (player.isAi && player instanceof PlayerAI) player.setAIGuessQueue(this.aiGuessQueue);
      const wordToDraw = wordPacks.getRandomWord(this.wordPackName!);
      const thisChain = new Chain(
        wordToDraw, player, currentChainId++,
        this.timeLimit, this.showNeighbors, jsonPlayers
      );
      this.chains.push(thisChain);
      thisChain.sendLastLinkToThen(player, this.finalNumOfLinks, ({ link }: any) => {
        this.receiveLink(player, link, thisChain.id);
      });
    });
  }

  sendWordFirstChains() {
    let currentChainId = 0;
    const jsonPlayers = this.showNeighbors
      ? this.players.map((p) => p.getJson())
      : null;

    this.players.forEach((player) => {
      if (player.isAi && player instanceof PlayerAI) player.setAIGuessQueue(this.aiGuessQueue);
      const thisChain = new Chain(
        false, player, currentChainId++,
        this.timeLimit, this.showNeighbors, jsonPlayers
      );
      this.chains.push(thisChain);
      thisChain.sendLastLinkToThen(player, this.finalNumOfLinks, ({ link }: any) => {
        this.receiveLink(player, link, thisChain.id);
      });
    });
  }

  receiveLink(player: Player, link: { type: string; data: any }, chainId: number) {
    const chain = this.getChain(chainId);
    if (!chain) return;

    this.aiGuessQueue.playerAvailableForWork(player);

    if (link.type === "drawing") {
      chain.addLink(new DrawingLink(player, link.data));
    } else if (link.type === "word") {
      chain.addLink(new WordLink(player, stripTags(link.data)));
    }

    this.updateWaitingList();
    this.nextLinkIfEveryoneIsDone();
  }

  nextLinkIfEveryoneIsDone() {
    const listNotFinished = this.getListOfNotFinishedPlayers();
    const areChainsInitialized = this.players.length === this.chains.length;
    const allFinished = areChainsInitialized && listNotFinished.length === 0;
    const noneDisconnected = this.disconnectedPlayers.length === 0;

    if (allFinished && noneDisconnected) {
      this.aiGuessQueue.reset();
      if (this.shouldHaveThisManyLinks === this.finalNumOfLinks) {
        this.viewResults();
      } else {
        this.startNextLink();
      }
    }
  }

  startNextLink() {
    this.shouldHaveThisManyLinks++;
    this.roundNumber++;

    for (let i = 0; i < this.players.length; i++) {
      try {
        const thisRoundsLinkOrder = this.linkOrder[this.roundNumber];
        const thisChainIndex = thisRoundsLinkOrder[i];
        const thisChain = this.chains[thisChainIndex];
        const thisPlayer = this.players[i];
        thisChain.lastPlayerSentTo = thisPlayer.getJson();

        ((chain, player) => {
          chain.sendLastLinkToThen(player, this.finalNumOfLinks, ({ link }: any) => {
            this.receiveLink(player, link, chain.id);
          });
        })(thisChain, thisPlayer);
      } catch (error) {
        console.error(error);
        this.viewResults();
        return;
      }
    }
  }

  getChain(id: number): Chain | false {
    for (const chain of this.chains) {
      if (chain.id === id) return chain;
    }
    return false;
  }

  getChainByLastSentPlayerId(id: number): Chain | false {
    for (const chain of this.chains) {
      if (chain.lastPlayerSentTo.id === id) return chain;
    }
    return false;
  }

  viewResults() {
    const chains = this.getAllChains();
    this.canViewLastRoundResults = true;
    this.onResults();

    const roundTime = (Date.now() - this.startTime) / this.players.length;
    this.players.forEach((player) =>
      player.send("viewResults", {
        chains,
        ...(player.isHost ? { roundTime } : {}),
      })
    );
  }

  findReplacementFor(player: Player, gameCode: string) {
    this.disconnectedPlayers.push(player.getJson());
    this.updateWaitingList();
    this.sendUpdateToPotentialPlayers(gameCode);
  }

  getPlayersThatNeedToBeReplaced(): PlayerJson[] {
    return this.disconnectedPlayers;
  }

  canBeReplaced(playerToReplaceId: number): boolean {
    return this.disconnectedPlayers.some((p) => p.id === playerToReplaceId);
  }

  replacePlayer(playerToReplaceId: number, newPlayer: Player, gameCode: string) {
    for (let i = 0; i < this.disconnectedPlayers.length; i++) {
      if (this.disconnectedPlayers[i].id === playerToReplaceId) {
        newPlayer.id = this.disconnectedPlayers[i].id;
        const idx = this.getPlayerIndexById(playerToReplaceId);
        if (idx !== false) this.players[idx] = newPlayer;

        this.disconnectedPlayers.splice(i, 1);
        this.potentialPlayers = this.potentialPlayers.filter((p) => p !== newPlayer);
        this.sendUpdateToPotentialPlayers(gameCode);

        if (newPlayer.isAi && newPlayer instanceof PlayerAI)
          newPlayer.setAIGuessQueue(this.aiGuessQueue);

        const dpChain = this.getChainByLastSentPlayerId(newPlayer.id);
        if (dpChain) {
          const dpDidFinish = dpChain.getLength() === this.shouldHaveThisManyLinks;
          if (dpDidFinish) {
            newPlayer.socket.emit("showWaitingList", {});
          } else {
            dpChain.sendLastLinkToThen(newPlayer, this.finalNumOfLinks, ({ link }: any) => {
              this.receiveLink(newPlayer, link, dpChain.id);
            });
          }
        }
        return newPlayer;
      }
    }
  }

  updateWaitingList() {
    this.sendToAll("updateWaitingList", {
      notFinished: this.getListOfNotFinishedPlayers(),
      disconnected: this.disconnectedPlayers,
    });
  }

  sendUpdateToPotentialPlayers(gameCode: string) {
    const payload = { gameCode, players: this.getPlayersThatNeedToBeReplaced() };
    this.potentialPlayers.forEach((p) => p.send("replacePlayer", payload));
  }

  getListOfNotFinishedPlayers(): PlayerJson[] {
    const playerList: PlayerJson[] = [];
    for (const chain of this.chains) {
      const player = this.getPlayer(chain.lastPlayerSentTo.id);
      if (player && chain.getLength() !== this.shouldHaveThisManyLinks && player.isConnected) {
        playerList.push(chain.lastPlayerSentTo);
      }
    }
    return playerList;
  }

  getPlayer(id: number): Player | false {
    for (const p of this.players) {
      if (p.id === id) return p;
    }
    return false;
  }

  getPlayerIndexById(id: number): number | false {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].id === id) return i;
    }
    return false;
  }

  sendToAll(event: string, data: any) {
    this.players.forEach((p) => p.send(event, data));
  }

  getAllChains(): ChainJson[] {
    return this.chains.map((c) => c.getJson());
  }

  validTurnLimit(enteredTurnLimit: number): number {
    return getNewTurnLimit({
      modifier: 0,
      prevTurnLimit: enteredTurnLimit,
      numPlayers: this.players.length,
      prevNumPlayers: this.players.length,
      isWordFirst: this.isWordFirstGame,
    }).newTurnLimit;
  }
}

// ============================================================
// Game
// ============================================================

class Game {
  code: string;
  onEmpty: () => void;
  players: Player[] = [];
  host: Player | undefined;
  inProgress: boolean = false;
  currentRound: Round | undefined;
  private currentId: number = 1;
  private botCount: number = 0;
  private currentRoundNum: number = 1;
  timeOfLastAction: Date = new Date();

  constructor(code: string, onEmpty: () => void) {
    this.code = code;
    this.onEmpty = onEmpty;
    setTimeout(() => this.deleteGameIfEmpty(), 60 * 1000);
  }

  newPlayer(name: string, socket: Socket): Player {
    return new Player(name, socket, this.getNextId());
  }

  addPlayer(name: string, socket: Socket): Player {
    const newPlayer = this.newPlayer(name, socket);
    this.initPlayer(newPlayer);
    this.players.push(newPlayer);
    this.sendUpdatedPlayersList();
    return newPlayer;
  }

  addBotPlayer(): Player | false {
    if (this.botCount >= BOT_NAMES.length) return false;
    this.botCount++;
    const newPlayer = new PlayerAI(
      BOT_NAMES[this.botCount],
      undefined,
      this.getNextId()
    );
    this.players.push(newPlayer);
    this.sendUpdatedPlayersList();
    return newPlayer;
  }

  removeBotPlayer() {
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].isAi) {
        this.removePlayer(this.players[i].id);
        this.botCount--;
        this.sendUpdatedPlayersList();
        break;
      }
    }
  }

  sendUpdatedSettings(setting: any) {
    this.sendToAll("updateSettings", {
      setting,
      canViewLastRoundResults:
        this.currentRound && this.currentRound.canViewLastRoundResults,
    });
  }

  initPlayer(newPlayer: Player) {
    if (this.players.length === 0) {
      this.host = newPlayer;
      newPlayer.makeHost();
    }

    newPlayer.socket.on("disconnect", () => {
      newPlayer.isConnected = false;
      if (this.inProgress && this.currentRound) {
        this.currentRound.findReplacementFor(newPlayer, this.code);
      } else {
        this.removePlayer(newPlayer.id);
      }
      this.onPlayerDisconnect(newPlayer);
      this.sendUpdatedPlayersList();
    });

    newPlayer.socket.on("viewPreviousResults", () => {
      if (this.currentRound && this.currentRound.canViewLastRoundResults) {
        newPlayer.send("viewResults", {
          chains: this.currentRound.getAllChains(),
          isViewPreviousResults: true,
        });
      }
    });
  }

  onPlayerDisconnect({ id }: Player) {
    const noHost = !this.host;
    const playerWasHost = this.host && id === this.host.id;

    if (playerWasHost || noHost) {
      this.host = undefined;
      for (const p of this.players) {
        if (p.isConnected && !p.isAi) {
          this.host = p;
          p.makeHost();
          break;
        }
      }
    }
    this.deleteGameIfEmpty();
  }

  deleteGameIfEmpty() {
    if (this.code === "ffff") return;
    const allDisconnected = this.players.every((p) => !p.isConnected || p.isAi);
    if (allDisconnected) this.onEmpty();
  }

  removePlayer(id: number) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx > -1) this.players.splice(idx, 1);
    if (this.players.length === 0) this.onEmpty();
  }

  getPlayer(id: number): Player | false {
    return this.players.find((p) => p.id === id) || false;
  }

  getNextId(): number {
    return this.currentId++;
  }

  getNextRoundNum(): number {
    return this.currentRoundNum++;
  }

  getJsonGame() {
    return {
      code: this.code,
      players: this.players.map((p) => p.getJson()),
      inProgress: this.inProgress,
      canViewLastRoundResults:
        this.currentRound !== undefined && this.currentRound.canViewLastRoundResults,
    };
  }

  sendUpdatedPlayersList() {
    this.sendToAll("updatePlayerList", {
      players: this.getJsonGame().players,
      canViewLastRoundResults:
        this.currentRound !== undefined && this.currentRound.canViewLastRoundResults,
    });
  }

  sendToAll(event: string, data: any) {
    this.players.forEach((player) => {
      player.socket.emit(event, {
        success: true,
        event,
        gameCode: this.code,
        player: player.getJson(),
        data,
      });
    });
  }

  startNewRound(
    timeLimit: number,
    wordPackName: string | null,
    showNeighbors: boolean,
    turnLimit: number
  ) {
    this.inProgress = true;
    this.currentRound = new Round(
      this.getNextRoundNum(),
      this.players,
      timeLimit,
      wordPackName,
      showNeighbors,
      turnLimit,
      () => {
        this.inProgress = false;
        this.sendUpdatedPlayersList();
        this.timeOfLastAction = new Date();
      }
    );
    this.currentRound.start();
  }
}

// ============================================================
// Drawphone (Game Manager)
// ============================================================

class Drawphone {
  games: Game[] = [];
  locked: boolean = false;
  minutesUntilRestart: number = 0;

  constructor(devModeEnabled: boolean) {
    if (devModeEnabled) {
      this.newGame("ffff");
    }
  }

  newGame(forceCode?: string): Game | false {
    if (this.locked) return false;
    const newCode = forceCode || this.generateCode();
    const newGame = new Game(newCode, () => this.removeGame(newCode));
    this.games.push(newGame);
    return newGame;
  }

  findGame(code: string): Game | false {
    if (!code || code.length !== 4) return false;
    return this.games.find((g) => g.code === code.toLowerCase()) || false;
  }

  generateCode(): string {
    let code: string;
    const possible = "abcdefghijklmnopqrstuvwxyz";
    do {
      code = "";
      for (let i = 0; i < 4; i++) {
        code += possible.charAt(Math.floor(Math.random() * possible.length));
      }
    } while (this.findGame(code));
    return code;
  }

  removeGame(code: string) {
    const idx = this.games.findIndex((g) => g.code === code);
    if (idx > -1) this.games.splice(idx, 1);
  }

  lock() {
    this.locked = true;
    this.minutesUntilRestart = 16;
    const interval = setInterval(() => {
      this.minutesUntilRestart--;
      if (this.minutesUntilRestart <= 0) clearInterval(interval);
    }, 1000 * 60);
  }
}

// ============================================================
// Socket.IO Server
// ============================================================

const drawphone = new Drawphone(process.env.NODE_ENV === "development");

io.on("connection", (socket) => {
  let thisGame: Game | false = false;
  let thisPlayer: Player | undefined;

  socket.on("newGame", ({ name }) => {
    thisGame = drawphone.newGame();
    if (!thisGame) {
      socket.emit("lockMessage", drawphone.minutesUntilRestart);
      return;
    }
    thisPlayer = thisGame.addPlayer(stripTags(name), socket);
    socket.emit("joinedGame", { game: thisGame.getJsonGame() });
  });

  socket.on("joinGame", ({ code, name }) => {
    thisGame = drawphone.findGame(code);
    if (!thisGame) {
      socket.emit("joinGameRes", { success: false, error: "Game not found" });
      return;
    }
    if (thisGame.inProgress) {
      if (thisGame.currentRound) {
        const newPlayer = thisGame.newPlayer(stripTags(name), socket);
        thisGame.currentRound.potentialPlayers.push(newPlayer);
        thisPlayer = newPlayer;
        const payload = {
          gameCode: thisGame.code,
          players: thisGame.currentRound.getPlayersThatNeedToBeReplaced(),
        };
        socket.emit("replacePlayer", { you: newPlayer.getJson(), data: payload });
      }
      return;
    }
    thisPlayer = thisGame.addPlayer(stripTags(name), socket);
    socket.emit("joinedGame", { game: thisGame.getJsonGame() });
  });

  socket.on("addBot", () => {
    if (thisGame && thisPlayer?.isHost) thisGame.addBotPlayer();
  });

  socket.on("removeBot", () => {
    if (thisGame && thisPlayer?.isHost) thisGame.removeBotPlayer();
  });

  socket.on("startGame", ({ timeLimit, wordPackName, showNeighbors, turnLimit }) => {
    if (thisGame && thisPlayer?.isHost) {
      thisGame.startNewRound(timeLimit || 0, wordPackName || null, !!showNeighbors, turnLimit || 0);
    }
  });

  socket.on("replacePlayerConfirm", ({ playerToReplaceId }) => {
    if (thisGame && thisGame.currentRound && thisPlayer) {
      if (thisGame.currentRound.canBeReplaced(playerToReplaceId)) {
        thisGame.currentRound.replacePlayer(playerToReplaceId, thisPlayer, thisGame.code);
      }
    }
  });

  socket.on("updateSettings", ({ setting }) => {
    if (thisGame && thisPlayer?.isHost) {
      thisGame.sendUpdatedSettings(setting);
    }
  });

  socket.on("viewPreviousResults", () => {
    if (thisGame && thisGame.currentRound && thisGame.currentRound.canViewLastRoundResults && thisPlayer) {
      thisPlayer.send("viewResults", {
        chains: thisGame.currentRound.getAllChains(),
        isViewPreviousResults: true,
      });
    }
  });
});

// Serve static files
app.use(express.static(path.join(__dirname, "client/dist")));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Drawphone server running on port ${PORT}`));
