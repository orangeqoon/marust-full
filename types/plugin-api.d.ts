/**
 * プラグインの型（検査用。実行には使わない）。正本は docs/PLUGIN-API.md と host/core/plugin-registry.js の makeCtx。
 * プラグインの index.js の先頭に // @ts-check を書き、ctx の引数に @param {import('../../types/plugin-api').PluginContext} ctx を付けると、
 * ctx の名前の打ち間違いを npm run check（tsc）が見つける。
 */

export type PluginMode = 'legacy' | 'shadow' | 'live';
export type LogLevel = 'info' | 'warn' | 'error' | string;

/** 種類（画面の「種類ごと」の分け方に使う決まった語。host/core/manifest-claims.js の CATEGORY_WORDS） */
export type PluginCategory = 'destination' | 'title' | 'comment' | 'slot' | 'login' | 'look' | 'layout' | 'tool' | 'connect' | 'dev' | 'set';

/** パネルの名乗り（計画 X・P1）。本体はプラグインの名前を知らず、パネルが自分で言う */
export interface PanelClaims {
  /** 昔の配置に残っているパネルの id（読み替えて開く） */
  aliases?: string[];
  /** 初めの配置で開く段階（standard／advanced）。順番は dockOrder（小さいほど先） */
  dock?: Array<'standard' | 'advanced'>;
  dockOrder?: number;
  /** 上のメニューの行。in: view（表示）／file（ファイル）／none（出さない）。言葉はプラグインが持つ */
  menu?: { key: string; title: string; desc?: string; order?: number; in?: 'view' | 'file' | 'none'; min?: 'standard' | 'advanced'; orDev?: boolean };
}

export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  manifestVersion?: 1 | 2;
  runtime?: 'inproc' | 'child' | 'external';
  main?: string;
  kind?: 'integration' | 'ui' | 'site' | 'sink' | 'slot' | string;
  audience?: 'public' | 'author' | string;
  stability?: 'stable' | 'experimental' | string;
  /** 読み込む段階。basic＝どの段階でも／standard＝中級から／advanced＝上級から。無ければ advanced（サイトと feature.level が standard のものは standard）。外から入れたものは必ず advanced */
  tier?: 'basic' | 'standard' | 'advanced';
  defaultMode?: PluginMode;
  /** 種類 1 つ。決まった語だけ（データだけのプラグインは kind から決まる）。※ kind は読み込み方の分類で、別の欄 */
  category?: PluginCategory;
  /** 効くサイトの id（["youtube"]）。全部に効くなら ["*"]。サイトに関係なければ書かない */
  for?: string[];
  /** 検索用の自由な語（分け方には使わない） */
  tags?: string[];
  /** イベント・親の窓の操作の持ち主の名乗り。内蔵だけ有効（host/core/owners.js）。先に名乗ったものが勝つ */
  owns?: { events?: string[]; parentActions?: string[] };
  dataDirId?: string;
  provides?: string[];
  requires?: string[];
  needs?: string[];
  secrets?: string[];
  subscribes?: string[];
  siblings?: string[];
  chatSource?: string;
  actions?: Record<string, 'read' | 'write'>;
  timeouts?: { load?: number; start?: number; stop?: number; destroy?: number; onEvent?: number; [name: string]: number | undefined };
  panels?: Array<{ name: string; title?: string; file: string } & PanelClaims>;
  /** 画面の差し込み口（V7）。panels は ui.panels の別名。relay は内蔵・作者用だけ有効 */
  ui?: {
    panels?: Array<{ name: string; title?: string; file: string }>;
    popup?: Array<{ name: string; title: string; file: string }>;
    settings?: { title: string; file: string };
    menu?: Array<{ label: string; method?: string; openPanel?: string }>;
    slots?: Array<{ slot: 'home.top' | 'home.siteCard.footer'; title?: string; file: string }>;
    relay?: string[];
  };
  overlays?: Array<{ name: string; fields?: unknown }>;
  configSchema?: unknown;
  /** 中級の「機能」一覧の説明。needs は login:<サイト>／site:<サイト>（入っていないと読み込まない）／obs。tip は 3 回配信したあとの紹介の文 */
  feature?: { label: string; hint?: string; level?: 'standard' | 'advanced'; activation?: 'live' | 'shadow' | 'guide'; order?: number; needs?: string[]; openPanel?: string; tip?: string; tipAliases?: string[] };
  /** サイトの説明（plugins/sites/<サイト>/ の manifest）。order＝並べる順・autoSlot＝自動枠取りの部品を持つ */
  site?: { id: string; name: string; order?: number; autoSlot?: boolean; [extra: string]: unknown };
  /** セット（kind: "set"・データだけ）。中身は機能の id の一覧 */
  set?: { label: string; members: string[] };
  /** 見た目の「標準」の印（kind: "theme"・内蔵だけ） */
  isDefault?: boolean;
  [extra: string]: unknown;
}

export interface BusMeta {
  id: string;
  version: number;
  occurredAt: number;
  source: string;
  correlationId: string;
  pluginId: string;
}

export interface SessionView {
  active: boolean;
  title: string;
  state: string;
  elapsedMs: number;
}

export interface Fail { ok: false; error: string }
export type Result<T = {}> = (({ ok: true } & T) | Fail);

export interface PluginContext {
  readonly id: string;
  /** 外から入れたプラグインには渡らない */
  core?: unknown;
  readonly pluginDir: string;
  /** 読み取り専用のコピー */
  readonly manifest: PluginManifest;
  /** 読んだときに作られる自分専用のデータ置き場 */
  readonly dataDir: string;
  logger(level: LogLevel, message: string): void;
  /** 秘密らしい値を伏せた文字列にする（本体のログと同じ規則。K2 より前から有る） */
  redact(text: unknown): string;
  /** 日付ごとの JSONL 追記（K2）。書く先は自分の dataDir。name は [A-Za-z0-9_-]{1,64}。失敗は false */
  readonly log: {
    appendJsonl(name: string, row: unknown, options?: { now?: Date | number | (() => Date | number) }): boolean;
  };
  /** 監査の行の形（本体が決める）と、本体の記録 logs/marust の shadow への追記（K2）。追記は provides に title.fanout@1 を持つ内蔵・作者用だけ（ほかは false） */
  readonly audit: {
    readonly fields: {
      localIso(date?: Date): string;
      clipField(value: unknown): { length: number; head: string };
      summarizeSites(rows: unknown[]): Array<{ id: string; result: string; message: string; mode: string }>;
    };
    append(record: unknown): boolean;
  };
  /** イベント名の一覧（凍結。K2） */
  readonly events: { readonly NAMES: Readonly<Record<string, string>> };
  /** 丸ストの版と配布ページ（凍結・読むだけ。K3）。外から入れたプラグインには渡らない */
  readonly app?: { readonly version: string; readonly releasesRepo: string };
  emit(eventName: string, payload?: unknown): void;
  mode(): PluginMode;
  bus: {
    publish(name: string, payload?: unknown, info?: { correlationId?: string }): number;
    /** manifest の subscribes が覆うパターンだけ。拒否されたら null */
    subscribe(pattern: string, handler: (name: string, payload: unknown, meta: BusMeta) => unknown): (() => void) | null;
  };
  sessions: {
    view(): SessionView;
    start(input: unknown): Result;
    pause(): Result;
    resume(): Result;
    end(input?: unknown): Result;
    retitle(title: string): Result;
  };
  secrets: {
    get(name: string): Promise<Result<{ value: string }>>;
    set(name: string, value: string): Promise<Result>;
  };
  overlay: {
    publish(name: string, values: Record<string, unknown>): Result<{ values: Record<string, unknown> }>;
  };
  chat: {
    ingest(message: unknown): Result;
    claim(site: string): Result;
    release(site: string): Result;
  };
  destinations: {
    list(): unknown;
    /** 配信先の集計（読むだけ・凍結。K3）。ready は OBS エンジンが最初の同期を終えたか */
    aggregate(): { readonly ready: boolean; readonly known: boolean; readonly streaming: boolean; readonly emergency: boolean; readonly anyOutputLive: boolean };
    /** 旧い置き場（state.json）のセッションの写し。内蔵の session だけ（初回の移しかえ用） */
    legacySession(): unknown | null;
  };
  /** 核のキーの口（K3）。内蔵の hotkeys だけ（manifest needs に keys）。検査も押下の実行も核 */
  readonly keys?: {
    reload(): Promise<Result<Record<string, unknown>>>;
    save(bindings: unknown[]): Promise<Result<Record<string, unknown>>>;
    list(): Result<{ bindings: unknown[] }>;
    release(): Result;
  };
  /** 使っているブラウザで URL を開く口（K3）。内蔵で needs に external.open を書いたものだけ。https かつ manifest external.hosts の名前だけ（他は bad-url で reject） */
  readonly external?: { open(url: string): Promise<unknown> };
  /** プラグインの動いている／モードの読みだけの口（K3）。内蔵の chat-inlet だけ */
  readonly pluginStates?: { isRunning(id: string): boolean; modeOf(id: string): PluginMode };
  /** 本体の API を呼ぶ・自分の API を出す（内蔵だけ。manifest の api.calls／api.namespaces に書いた名前だけ） */
  readonly api?: {
    call(method: string, params?: unknown): Promise<any>;
    register(method: string, handler: (params: any, info: { kind: string; clientId: string }) => unknown, options?: { access?: 'read' | 'write'; windowOnly?: boolean; description?: string; params?: unknown }): Result;
  };
  /** サイトの決まったメソッドだけを呼ぶ口（manifest の peers.methods。内蔵だけ） */
  readonly peers?: {
    list(): unknown;
    run(id: string, method: string, args?: unknown[]): Promise<any>;
  };
  /** 試験や作者用のプラグインに渡す設定（本体は渡さない） */
  readonly config?: unknown;
  /** 旧い名前の OBS の読み口（試験用。ctx.obs が正） */
  readonly obsConnection?: unknown;
  /** manifest の needs に obs.read を書いたときだけ */
  obs?: {
    getStreamStatus(): Promise<unknown | null>;
    isStreaming(): Promise<boolean>;
    /** needs に obs.streamControl も書いたときだけ */
    streamControl?(action: 'start' | 'stop'): Promise<Result>;
  };
}

export interface Plugin {
  load(ctx: PluginContext): void | Promise<void>;
  start(ctx: PluginContext): void | Promise<void>;
  stop(ctx: PluginContext): void | Promise<void>;
  destroy(ctx: PluginContext): void | Promise<void>;
  health?(ctx: PluginContext): unknown;
  onEvent?(name: string, payload: unknown, meta: BusMeta): unknown;
  [action: string]: unknown;
}
