# convergent

Claude Code 向け自律開発オーケストレーター。ゴールとコンテキストを受け取り、タスクに分解して**収斂進化**アプローチで実装する — 複数のAIペルソナが独立して解決策を設計し、それらを最適な実装プランに統合する。

## 仕組み

```
Phase 0: タスク生成
  入力: --context（ファイル/ディレクトリ）+ --goal（自然言語）+ --instructions（任意）
  → 依存関係付きの構造化タスクキューを生成
  → 各タスクにタイプを割り当て: code | explore | command
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ タスクタイプによる分岐:                               │
│                                                     │
│ [code タスク] ── Phase A → Phase B → 検証 → Phase C  │
│ [explore タスク] ── 直接実行（調査・テスト → 報告）    │
│ [command タスク] ── 直接実行（デプロイ・コマンド実行）  │
└─────────────────────────────────────────────────────┘

code タスクのフロー:
  Phase A: 収斂進化
    → 3〜7のペルソナを並列起動（各ペルソナはRead/Glob/Grepツール使用可能）
    → 高コンセンサス検出時は早期終了
    → シンセサイザーが最適プランを合成
          │
          ▼
  Phase B: 実装
    → 収斂プランを実行（過去タスクの学習 + 探索結果を含むコンテキスト）
    → 検証を実行（lint, typecheck, test）→ 失敗時リトライ
          │
          ▼
  Phase C: マルチペルソナ・コードレビュー
    → 3つの専門レビュアーが並列に審査
    → 全員 approved → コミット / changes_requested → リトライ

explore タスクのフロー:
  → ユーザー設定の全ツール（Playwright CLI 等）を使って調査
  → 結果を findings.md に記録 → 後続タスクのコンテキストに自動伝播

command タスクのフロー:
  → 指定コマンドを実行 → 成否を判定

次のタスクへ（全タスク完了または予算超過までループ）
```

### 収斂進化とは

核となるアイデア：異なる優先度を持つ複数の独立エージェントが同じ問題を分析したとき、それらが**収斂する**要素はおそらく最良のアプローチである。意見の相違はシンセサイザーが各視点の根拠を重み付けして解決する。

ペルソナはタスクの複雑度に応じて割り当てられる：

| 複雑度 | ペルソナ | ユースケース |
|--------|----------|-------------|
| `trivial` | なし（直接プラン生成） | 単一ファイル、簡単な変更 |
| `standard` | pragmatist, tdd, security | 2〜5ファイル、中程度のロジック |
| `complex` | 全7ペルソナ | 6ファイル以上、アーキテクチャ変更 |

### タスクタイプ

Phase 0 はゴールを分析して各タスクに適切なタイプを自動で割り当てる：

| タイプ | 用途 | Phase A | 検証 | レビュー |
|--------|------|---------|------|----------|
| `code` | コードの実装・修正（デフォルト） | ペルソナ収斂 | lint/typecheck/test | マルチペルソナレビュー |
| `explore` | 探索的テスト・調査・情報収集 | スキップ | なし | なし |
| `command` | デプロイ・マイグレーション等のコマンド実行 | スキップ | なし | なし |

`explore` タスクの結果（findings.md）は、後続タスクのコンテキストに自動で注入される。例えば「探索テストでバグを発見 → コードで修正」というフローが自然に実現できる。

ユーザーの `~/.claude/settings.json` で許可されたツール（Playwright CLI、MCP ツール等）は、`explore` / `command` タスクで自動的に利用可能。

## クイックスタート

```bash
# 前提条件: Bun, claude CLI
# 確認:
bun --version
claude --version

# プロジェクトで実行
convergent \
  --context "docs/,src/,README.md" \
  --goal "JWT トークンによるユーザー認証を実装する"
```

## 使い方

```bash
# 完全自律実行
convergent \
  --context "docs/,src/,memo/remaining-tasks.md" \
  --goal "remaining-tasks.md の残タスクをすべて実装する"

# 自然言語の指示だけで実行（goal, context は自動推定）
convergent \
  --instructions "認証をJWTからセッションベースに変更。ユーザーモデルにroleフィールドを追加"

# ファイルから指示を読み込み（TODO.md など）
convergent --instructions-file ./TODO.md

# 探索的テスト → バグ修正 → デプロイ（explore/code/command タスクの混合）
convergent \
  --instructions "本番環境を Playwright CLI で探索的にテストし、見つかったバグを修正してデプロイする"

# goal + instructions で方向性と具体的指示を分けて指定
convergent \
  --context "src/" --goal "ECサイトのバックエンド改善" \
  --instructions "認証をJWTからセッションベースに変更。ユーザーモデルにroleフィールドを追加"

# タスクキュー生成のみ（実行前に確認）
convergent \
  --context "src/" \
  --goal "TypeScript の型エラーをすべて修正する" \
  --review

# 中断後の再開（Ctrl+C）
convergent --resume

# 失敗タスクをリセットして再試行
convergent --resume --retry-failed

# プラン生成まで（実装なし）で確認
convergent \
  --context "src/" \
  --goal "認証機能を実装する" \
  --dry-run

# タスクキューを自然言語で修正（--review 後に使用）
convergent \
  --refine "task-001は不要、削除して。task-003の複雑度をstandardに変更"

# 予算とモデルを指定
convergent \
  --context "." \
  --goal "ダークモード対応を追加する" \
  --max-budget 20.00 \
  --model opus
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--context <paths>` | カンマ区切りの分析対象ファイル/ディレクトリ |
| `--goal <text>` | 達成したいこと（自然言語） |
| `--instructions <text>` | タスク生成への具体的な指示（自然言語） |
| `--instructions-file <path>` | ファイルから指示を読み込み（TODO.md 等） |
| `--resume` | `.convergent/state.json` から再開 |
| `--retry-failed` | `--resume` 時に failed/blocked タスクを pending にリセットして再試行 |
| `--review` | タスク生成後に停止して確認 |
| `--dry-run` | Phase 0 + Phase A のみ実行（プラン生成まで、実装なし） |
| `--refine <text>` | 最新のタスクキューを自然言語の指示で修正 |
| `--config <path>` | カスタム設定ファイル |
| `--max-budget <USD>` | 予算上限（デフォルト: $50） |
| `--model <model>` | 全フェーズのモデルを上書き |
| `--verbose` | デバッグログ出力 |

### レビュー → 修正 → 実行ワークフロー

`--review` と `--refine` を組み合わせることで、実行前にタスクキューを精査・修正できる：

```bash
# 1. タスクキューを生成して確認
convergent \
  --context "src/" --goal "認証機能を実装する" --review

# 2. 自然言語でタスクキューを修正（繰り返し可能）
convergent \
  --refine "task-001は不要。task-003にE2Eテストの受入基準を追加して"

# 3. 納得したら実行
convergent --resume
```

`--refine` は何度でも実行できる。各回で最新の `tasks.json` を読み込み、指示に基づいて修正する。

### ドライラン → 実行ワークフロー

`--dry-run` を使うと、Phase 0（タスク生成）と Phase A（プラン策定）まで実行して停止する。各タスクの実装プランを確認してから実行に進める：

```bash
# 1. タスク生成 + プラン策定まで実行
convergent \
  --context "src/" --goal "認証機能を実装する" --dry-run

# 2. プランを確認（各タスクの synthesis.json を参照）
cat .convergent/latest/logs/task-001/synthesis.json | jq .

# 3. 納得したら実装を実行
convergent --resume
```

## 設定

プロジェクトルートに `convergent.config.json` を配置してカスタマイズ：

```json
{
  "models": {
    "planner": "sonnet",
    "persona": "sonnet",
    "synthesizer": "opus",
    "executor": "sonnet"
  },
  "budget": {
    "total_max_usd": 50.00,
    "per_task_max_usd": 10.00,
    "per_persona_max_usd": 1.00,
    "synthesis_max_usd": 2.00,
    "execution_max_usd": 5.00,
    "review_max_usd": 2.00,
    "per_review_persona_max_usd": 0.80
  },
  "parallelism": {
    "persona_timeout_seconds": 120,
    "max_parallel_tasks": 3
  },
  "verification": {
    "commands": ["bun lint", "bun typecheck", "bun test"],
    "max_retries": 2,
    "timeout_seconds": 300,
    "parallel": true
  },
  "review": {
    "enabled": true,
    "max_retries": 2,
    "personas": ["correctness", "security", "maintainability"]
  },
  "personas": {
    "trivial": [],
    "standard": ["pragmatist", "tdd", "security"],
    "complex": ["conservative", "minimalist", "tdd", "performance", "ux", "security", "pragmatist"]
  },
  "git": {
    "auto_commit": true
  }
}
```

### 検証コマンド

`verification.commands` にプロジェクトの品質チェックを設定する。オーケストレーターは各タスク実装後にこれらを実行する：

```json
{
  "verification": {
    "commands": ["npm run lint", "npm run typecheck", "npm test"],
    "max_retries": 2
  }
}
```

コマンドが失敗した場合、エラー出力をコンテキストにして Phase B をリトライする。`max_retries` 回失敗すると、タスクは失敗としてマークされ変更はリバートされる。

`verification.commands` が空（`[]`）の場合、検証はスキップされる。

## 出力

実行時データはすべて `.convergent/` に保存される（`.gitignore` に追加済み）。各実行はタイムスタンプ付きディレクトリに格納され、過去のランを振り返ることができる：

```
.convergent/
├── latest -> runs/2026-02-12T20-30-00  # 最新ランへのシンボリックリンク
└── runs/
    ├── 2026-02-12T20-30-00/            # 1回目の実行
    │   ├── tasks.json
    │   ├── state.json
    │   ├── budget.json
    │   ├── learnings.json               # タスク間学習データ
    │   ├── reports/
    │   │   ├── summary.md
    │   │   └── task-001.md
    │   └── logs/
    │       ├── orchestrator.log
    │       ├── phase0/
    │       │   ├── raw_output.json
    │       │   └── project_summary.md   # プロジェクト構造サマリー
    │       └── task-001/
    │           ├── persona-conservative.json
    │           ├── persona-tdd.json
    │           ├── persona-security.json
    │           ├── synthesis.json              # 収斂プラン
    │           ├── execution.log
    │           ├── verify.log
    │           ├── review-correctness.json     # 正確性レビュー結果
    │           ├── review-security.json        # セキュリティレビュー結果
    │           ├── review-maintainability.json  # 保守性レビュー結果
    │           └── review.json                 # マージされた最終レビュー結果
    └── 2026-02-12T21-45-00/            # 2回目の実行
        └── ...
```

`--resume` は `latest` シンボリックリンクを辿って最新のランを再開する。

## インテリジェント機能

### 自然言語による指示

`--goal` がプロジェクト全体の方向性を示すのに対し、`--instructions` / `--instructions-file` で具体的な実装指示を追加できる。コードベースの自動分析と人間の意図を組み合わせたタスク生成が可能：

- **インライン指示**: `--instructions "認証をJWTからセッションに変更して"`
- **ファイル指示**: `--instructions-file ./TODO.md` — 既存の TODO リストやイシューをそのまま入力
- `--instructions` だけで実行可能 — `--goal` は指示の先頭行から自動生成、`--context` はカレントディレクトリ（`.`）にフォールバック
- 指示は Phase 0 のプロンプトに `## User Instructions` セクションとして組み込まれ、タスク生成時に優先される

### コンテキスト品質向上

- **import 依存グラフトレース**: タスクの `context_files` から import/require を辿り、関連ファイルを自動で発見。Phase A と Phase B のプロンプトに含める
- **プロジェクト構造サマリー**: Phase 0 でソースファイルの一覧と各ファイルの一行説明を自動生成。Phase A のペルソナにプロジェクトの鳥瞰図を提供
- **ペルソナの Read ツールアクセス**: Phase A のペルソナは Read, Glob, Grep ツールを使ってコードベースを探索可能。提供されたコンテキスト以外のファイルも確認できる
- **シグネチャ抽出**: ディレクトリ内のソースファイルは先頭100行ではなく、export/type/interface/function のシグネチャを抽出してコンテキストに含める。ファイル全体の公開APIを俯瞰可能

### タスク間学習

- **レビューフィードバック伝播**: あるタスクの Phase C レビューで指摘された問題を蓄積し、以降のタスクの Phase B プロンプトに「過去の教訓」として含める
- **失敗パターン蓄積**: Phase A/B/検証/レビューの失敗パターンを記録し、同じ間違いの繰り返しを防止
- **重複排除**: 類似した学習エントリは自動で排除し、プロンプトの無駄な膨張を防止

### 実行効率

- **Phase A 早期終了**: 十分な数のペルソナが完了しファイルレベルの合意度が70%以上に達した場合、残りのペルソナをスキップして合成に進む
- **Phase A 並列プリフェッチ**: 依存関係のないタスクの Phase A（プラン策定）を並列実行。Phase A は Read-only のため安全に並列化可能（デフォルト最大3並列）
- **検証コマンド並列実行**: lint, typecheck, test を並列実行して検証時間を短縮
- **差分レビュー**: Phase C リトライ時、前回のレビュー指摘事項と修正後の差分にフォーカスした効率的な再レビューを実行

## 耐障害性

### Phase A リトライ＋フォールバック

ペルソナが構造化出力を返せなかった場合の段階的リカバリ：

1. **自動リトライ**: 失敗したペルソナを1回再試行（必要最低数に達するまで）
2. **単一プラン採用**: 1つだけ成功した場合、シンセシスをスキップしてそのプランを直接使用
3. **ダイレクトプラン**: 全ペルソナ失敗時、ペルソナなしで直接プランを生成

### レビュー重大度フィルタ

Phase C レビューで `changes_requested` が返されても、指摘がすべて `info` レベル（警告・エラーなし）の場合は `approved` として扱う。`.gitkeep` の欠落など些細な指摘でのリトライループを防止。

### 差分なし検知

レビュー修正を試みた後、git diff が変化していなければ修正エージェントが効果的な変更を加えられなかったと判断し、タスクを承認して次に進む。無限リトライループを防止。

### スマートサーキットブレーカー

Phase A の構造化出力失敗（ペルソナの出力形式の問題）はソフト失敗として扱い、サーキットブレーカーのカウントに含めない。実装やレビューの本質的な失敗のみがカウントされ、3回連続で停止する。

### API 呼び出しの指数バックオフリトライ

Claude CLI 呼び出しでレート制限、接続エラー、サーバーエラー（429/502/503/529）が発生した場合、指数バックオフ（3秒→6秒→12秒）で最大2回リトライする。一時的な障害での無駄な失敗を防止。

### 検証コマンドのタイムアウト

検証コマンド（lint, typecheck, test）にタイムアウトを設定可能（デフォルト: 5分）。テストの無限ループでオーケストレーター全体がハングすることを防止。`verification.timeout_seconds` で設定。

### `--retry-failed` による再試行

`--resume --retry-failed` で失敗・ブロックされたタスクを pending にリセットして再実行できる。依存先の失敗でブロックされたタスクも連鎖的にリセットされる。

## 安全機能

- **予算制限**: ペルソナ単位、タスク単位、合計の予算上限
- **サーキットブレーカー**: 3回連続タスク失敗で停止（Phase A 構造化出力失敗はカウント外）
- **検証ゲート**: lint + typecheck + test がパスしないとコミットしない
- **マルチペルソナレビューゲート**: 検証通過後、3つの専門レビュアーが並列に正確性・セキュリティ・保守性を審査（1人でも reject → 修正必要）
- **自動リバート**: 失敗タスクの変更を自動で巻き戻し
- **再開可能**: Ctrl+C で状態保存、`--resume` で中断箇所から再開

## 設計方針: インタラクティブ介入をしない理由

このツールは実行中の Claude とのやりとりに人間が介入する機能を**意図的に提供していない**。

理由はシンプルで、このツールの存在意義が「人間というボトルネックを排除して自律的に開発を回す」ことにあるため。途中で逐一介入するなら、素の Claude Code を手で使うのと変わらない。

代わりに、以下の手段で**観測と制御**を提供している：

| 手段 | 人間の関与 |
|------|-----------|
| `.convergent/logs/` 配下の詳細ログ | 事後確認（各呼び出しのプロンプト・レスポンス全文） |
| ターミナル出力 | リアルタイム観測（進捗・コスト・成否） |
| Ctrl+C → `--resume` | 緊急停止と再開 |
| `--review` フラグ | Phase 0 後に一時停止してタスクキューを確認 |
| `--dry-run` フラグ | Phase A（プラン策定）まで実行して停止。実装前にプラン確認 |
| `--refine` フラグ | タスクキューを自然言語で修正（繰り返し可能） |
| 予算制限・サーキットブレーカー | 暴走防止の自動停止 |

「何が起きているか分からない不安」はログとターミナル出力で解消し、「止めたい」は Ctrl+C で対応する。実行中に方針を変えたくなったら、止めてからゴールを修正して再実行する方が、中途半端な介入よりも結果が良い。

## ペルソナ

| ペルソナ | 重視する観点 |
|---------|-------------|
| conservative | 安定性、実績あるパターン、エラーハンドリング |
| minimalist | 最小限のコード、不要な抽象化の排除 |
| tdd | テストファースト設計、エッジケースのカバー |
| performance | アルゴリズム効率、バンドルサイズ、レンダリング |
| ux | ローディング状態、エラーメッセージ、アクセシビリティ |
| security | 入力検証、認証境界、XSS/CSRF |
| pragmatist | 動くソフトウェアを出す、実用的なトレードオフ |

ペルソナは `lib/personas.json` を編集してカスタマイズ可能。

## レビューペルソナ

Phase C のコードレビューでは、以下の専門レビュアーが並列にレビューを行う：

| レビューペルソナ | 重視する観点 |
|----------------|-------------|
| correctness | プラン準拠、受入基準充足、ロジックの正確性 |
| security | 入力検証、認証境界、XSS/SQLi、シークレット漏洩 |
| maintainability | 不要な変更、パターン整合性、デッドコード、エラーハンドリング |

統合ルール：**ストリクト union** — 1人でも `changes_requested` を返せば全体が `changes_requested` になり、全ペルソナの指摘事項がマージされて Phase B リトライにフィードバックされる。

レビューペルソナは `lib/review_personas.json` を編集してカスタマイズ可能。`config.review.personas` を空配列にすると従来の単一レビュアーモードにフォールバックする。

## 必要要件

- [Bun](https://bun.sh/) ランタイム
- [Claude Code](https://claude.ai/code) CLI（`claude` コマンド）
- Git（自動コミット用）
