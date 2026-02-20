---
name: convergent
description: 収斂進化モデルによる自律開発オーケストレーター。複数のAIペルソナが独立に実装プランを作成し、収斂ポイントを抽出して最適な実装を自動実行する。
argument-hint: --goal "目標" --context "対象パス" [--review] [--resume] [--max-budget N] [--model model]
allowed-tools: Bash(convergent:*)
---

# convergent: 収斂進化型自律開発

convergent を実行する。このツールは Phase 0（タスク生成）→ Phase A（収斂進化）→ Phase B（実装）のパイプラインで自律的にコードを実装する。

## 引数が渡された場合

そのまま convergent.ts に渡して実行する:

```bash
convergent $ARGUMENTS
```

## 引数がない場合

ユーザーに以下を確認してから実行する:

1. **--goal**: 何を達成したいか（自然言語で）
2. **--context**: 分析対象のファイル/ディレクトリ（カンマ区切り）
3. **--review をつけるか**: タスク生成後に一旦止めて確認するか（推奨）
4. **--max-budget**: 予算上限 USD（デフォルト: 50）
5. **--model**: モデル指定（デフォルト: opus）

確認後、組み立てたコマンド��実行する。

## 実行例

```bash
# フル実行
convergent \
  --context "docs/,src/,README.md" \
  --goal "JWT認証を実装する"

# タスク確認してから実行
convergent \
  --context "src/" \
  --goal "型エラーをすべて修正" \
  --review

# 中断から再開
convergent --resume

# 予算指定
convergent \
  --context "." \
  --goal "ダークモード追加" \
  --max-budget 20.00
```

## 注意事項

- 実行には `bun` と `claude` CLI が必要
- 実行中のログは `.convergent/logs/` に保存される
- Ctrl+C で中断でき、`--resume` で再開可能
- 予算超過やタスク3連続失敗で自動停止する
- 実行時間が長い（タスク数×ペルソナ数に比例）ため、ターミナル出力で進捗を確認すること
