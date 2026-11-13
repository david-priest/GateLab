// layoutNavigationJa.ts — the Layout tab's navigation, sheet tabs, "Export all sheets" and list of
// keys in Japanese, keyed by the English the interface is written in; src/ui/i18n.tsx spreads this
// table into its own. Words the app already translates (Rename, Duplicate, Delete, Copy, Undo …)
// are not repeated here. Key names alone (Cmd-A, Escape, Enter) are left as they are.

export const LAYOUT_NAVIGATION_JA: Readonly<Record<string, string>> = {
  // Navigation (layoutNavigation.ts) and the item menu.
  "Zoom to selection": "選択範囲にズーム",
  // Sheet tabs (layoutSheets.ts).
  "Move left": "左へ移動",
  "Move right": "右へ移動",
  "Drag to reorder; double-click to rename; right-click for more": "ドラッグで並べ替え、ダブルクリックで名前を変更、右クリックでその他の操作",
  // Export all sheets (useExportAllSheets.ts).
  "Export all sheets": "すべてのシートを書き出し",
  "Sheet {n} of {count}": "シート {n} / {count}",
  "Write every sheet that has items: as PDF one file with each sheet's pages in sheet order; as SVG or PNG one zip with a folder per sheet": "項目のあるすべてのシートを書き出します。PDF はシート順に各シートのページを並べた 1 ファイル、SVG と PNG はシートごとのフォルダーを含む 1 つの zip です",
  // The list of keys (LayoutKeysHelp.tsx).
  "Keys": "キー操作",
  "Select": "選択",
  "Move and resize": "移動とサイズ変更",
  "Copy and paste": "コピーとペースト",
  "Order and group": "重ね順とグループ",
  "View": "表示",
  "Click": "クリック",
  "Select an item": "項目を選択",
  "Drag empty page": "空いたページをドラッグ",
  "Select several": "複数を選択",
  "Shift-click": "Shift+クリック",
  "Add to or remove from the selection": "選択に追加、または選択から除外",
  "Select nothing; cancel a drag or a shape being drawn": "選択を解除。ドラッグ中の移動や描画中の図形を取り消し",
  "Edit the selected text block": "選択したテキストブロックを編集",
  "Move; Shift holds the direction": "移動（Shift で方向を固定）",
  "Drag a corner or an edge": "角や辺をドラッグ",
  "Resize; Shift keeps the proportions, Option resizes from the centre": "サイズ変更（Shift で比率を維持、Option で中心から）",
  "Cmd while dragging": "ドラッグ中に Cmd",
  "Snapping off": "スナップを一時解除",
  "Arrow keys": "矢印キー",
  "Nudge 1 px; Shift: 10 px": "1 px 移動（Shift: 10 px）",
  "Option-drag": "Option+ドラッグ",
  "Copy where it is dropped": "ドロップした位置に複製",
  "Delete or Backspace": "Delete または Backspace",
  "Bring forward and send backward": "一段前面へ、一段背面へ",
  "Bring to front and send to back": "最前面へ、最背面へ",
  "Lock or unlock": "ロック、またはロック解除",
  "Space-drag": "Space+ドラッグ",
  "Move the view": "表示を移動",
  "Middle-button drag": "中ボタンでドラッグ",
  "Option-scroll or pinch": "Option+スクロール、またはピンチ",
  "Zoom about the pointer": "ポインターを中心にズーム",
  "Fit the page": "ページ全体を表示",
  "Zoom to the selection, or to everything": "選択範囲、または全体にズーム",
  "Zoom in and out": "拡大、縮小",
};
