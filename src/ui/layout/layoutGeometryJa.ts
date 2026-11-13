// layoutGeometryJa.ts — the Layout tab's geometry controls in Japanese, keyed by the English the
// interface is written in; src/ui/i18n.tsx spreads this table into its own.

export const LAYOUT_GEOMETRY_JA: Readonly<Record<string, string>> = {
  "Width": "幅",
  "Height": "高さ",
  "Keep proportions": "縦横比を保つ",
  "Typing a width sets the height to keep the item's proportions, and the reverse; dragging a handle keeps them too, and Shift frees them": "幅を入力すると縦横比を保つように高さが決まり、高さを入力すると幅が決まります。ハンドルのドラッグでも縦横比を保ち、Shift を押すと解除されます",
  "Show X, Y, width and height in {unit}": "X、Y、幅、高さを {unit} で表示",
  "Gap (mm)": "間隔 (mm)",
  "the item nearest the top left of the selection": "選択範囲の左上に最も近い項目",
  "Match width": "幅をそろえる",
  "Match height": "高さをそろえる",
  "Match size": "大きさをそろえる",
  "Give each selected item the width of {reference}, keeping each top-left corner; locked items are not changed": "選択した各項目の幅を{reference}に合わせます。各項目の左上の位置は変わりません。ロックした項目は変更しません",
  "Give each selected item the height of {reference}, keeping each top-left corner; locked items are not changed": "選択した各項目の高さを{reference}に合わせます。各項目の左上の位置は変わりません。ロックした項目は変更しません",
  "Give each selected item the width and height of {reference}, keeping each top-left corner; locked items are not changed": "選択した各項目の幅と高さを{reference}に合わせます。各項目の左上の位置は変わりません。ロックした項目は変更しません",
  "Arrange in grid…": "格子状に配置…",
  "Arrange in grid": "格子状に配置",
  "Place the selected items in a grid in reading order, from the selection's top-left corner; locked items stay where they are": "選択した項目を読む順に、選択範囲の左上から格子状に並べます。ロックした項目は動きません",
  "Across, then down": "横に並べてから下へ",
  "Down, then across": "下に並べてから横へ",
  "Space…": "間隔を指定…",
  "Space at a gap": "指定した間隔で並べる",
  "Space two or more items or groups at a typed gap; the first stays and each next one is put after the one before": "2つ以上の項目またはグループを入力した間隔で並べます。最初の項目は動かず、次の項目は前の項目の後ろに置かれます",
  "Direction": "方向",
  "Across": "横",
  "Down": "縦",
};
