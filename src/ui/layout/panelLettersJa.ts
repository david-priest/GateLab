// panelLettersJa.ts — the Layout tab's panel letters in Japanese, keyed by the English the
// interface is written in; src/ui/i18n.tsx spreads this table into its own.

export const PANEL_LETTERS_JA: Readonly<Record<string, string>> = {
  "Panel letters": "パネル記号",
  "Remove panel letters": "パネル記号を削除",
  "Letter each selected plot, chart or figure at its top left, in reading order; with nothing selected, every one on the sheet. An item that has a letter keeps it.": "選択したプロット・グラフ・図の左上に、読む順でパネル記号を付けます。何も選択していなければシート上のすべてに付けます。記号のある項目はそのままです。",
  "Remove the panel letters of the selection; with nothing selected, every panel letter on the sheet": "選択した項目のパネル記号を削除します。何も選択していなければシート上のすべてのパネル記号を削除します",
  "Letter size": "記号の大きさ",
  "Bold": "太字",
  "Letters": "記号の書き方",
  "A, B, C": "A, B, C",
  "a, b, c": "a, b, c",
  "How the sheet's panel letters are drawn. A letter sits at the top left of its item and moves with it; letters are given in reading order, rows from the top and left to right within a row, and renumber when items move.": "シートのパネル記号の描き方です。記号は項目の左上に置かれ、項目と一緒に動きます。記号は読む順（上の行から、行の中では左から右）に付けられ、項目を動かすと付け直されます。",
  "Panel letter of {item}": "{item} のパネル記号",
  "The letter is its item's place in reading order and is not edited as text. Drag it to set where it sits against its item; its size and style are the sheet's.": "記号は項目の読む順の位置で決まり、文字として編集はしません。ドラッグすると項目に対する位置を変えられます。大きさと書式はシートの設定です。",
};
