// tourJa.ts — the walkthrough tutorial in Japanese: its menu, its card, its chapters, and every
// step's title and body, keyed by the English the script is written in, as the rest of the
// interface's strings are (src/ui/i18n.tsx spreads this table into its own). A body built from
// the context is translated a sentence at a time, so each of its fragments is here too.
//
// The names of controls follow what the interface shows in Japanese: a label that is translated
// (変換, 全イベント, ルートからの全パス) is named in Japanese, and one that is not (Export PDF,
// Save Portable Copy, Leaves, Composition) keeps its English, so the reader finds what the step
// names on screen. Keys are named as a Mac names them; the card rewrites them for the keyboard
// in front of the reader.

export const TOUR_JA: Readonly<Record<string, string>> = {
  // ── The menu and the card ──
  "Tutorial": "チュートリアル",
  "A walk through every tab with the demo workspace": "デモワークスペースで全タブを巡るチュートリアル",
  "Start the tutorial": "チュートリアルを始める",
  "Start the tutorial again": "チュートリアルをもう一度始める",
  "Start again from the beginning": "最初からやり直す",
  "Resume at step {index} of {total}: {title}": "ステップ {index}/{total} から再開：{title}",
  "About the demo workspace": "デモワークスペースについて",
  "The demo workspace": "デモワークスペース",
  "The demo workspace is a published gating strategy with its FCS records and compensation: the strategy used to sort B cells for an in vitro assay.": "デモワークスペースは、発表済みのゲーティング戦略とその FCS 記録・補正をまとめたものです。in vitro アッセイのために B 細胞をソートした際の戦略です。",
  "Drag to move the card": "ドラッグしてカードを移動",
  "Step {index} of {total}": "ステップ {index} / {total}",
  "Next": "次へ",
  "Finish": "終了",
  "End tutorial": "チュートリアルを終える",
  "Already done": "完了済み",
  "Waiting for you to do this…": "操作をお待ちしています…",
  "This step needs a workspace open.": "このステップにはワークスペースを開いておく必要があります。",
  "Open the demo workspace": "デモワークスペースを開く",
  "This step is on the {tab} tab.": "このステップは{tab}タブで行います。",
  "This step is on the Compensation tab's {view} view.": "このステップは補正タブの{view}で行います。",
  "Take me there": "そこへ移動",

  // ── Chapters ──
  "Welcome": "はじめに",
  "The tree": "ツリー",
  "Saving": "保存",

  // ── Welcome ──
  "A walk through GateLab": "GateLab を一巡り",
  "This tutorial goes through every tab with the demo workspace: a published B cell sort strategy with its FCS records and compensation. Each step says what to do and moves on when you have done it; Skip moves on without. End tutorial keeps your place, and the Tutorial menu brings you back to it.": "このチュートリアルはデモワークスペース（発表済みの B 細胞ソート戦略と、その FCS 記録・補正）を使って全タブを巡ります。各ステップは何をするかを示し、それを行うと次へ進みます。「スキップ」は行わずに進みます。「チュートリアルを終える」を押すと位置が保存され、「チュートリアル」メニューからそこへ戻れます。",
  "A workspace is open ({name}); the tutorial goes on with it.": "ワークスペース（{name}）が開いています。チュートリアルはこのまま進みます。",
  "Open the Workspace menu and choose “Open the demo workspace”. The demo is the FCS records, their compensation and the gating tree, bundled as one .gatelab file.": "「ワークスペース」メニューを開き、「デモワークスペースを開く」を選びます。デモは FCS 記録とその補正、ゲーティングのツリーを 1 つの .gatelab ファイルにまとめたものです。",
  "The demo is the gating strategy of {figure} of {reference} (“{legend}”), on its presort record and companion records. The Tutorial menu keeps this reference under “About the demo workspace”.": "デモは {reference} の {figure} のゲーティング戦略（「{legend}」）を、そのプレソート記録と付随する記録に適用したものです。この文献は「チュートリアル」メニューの「デモワークスペースについて」にあります。",
  "The tutorial goes on with the workspace you opened. It was written for the demo: the gating strategy of {figure} of {reference}": "チュートリアルは、開いたワークスペースのまま進みます。本来はデモ（{reference} の {figure} のゲーティング戦略）向けに書かれています。",

  // ── Gating ──
  "The plot and its gate": "プロットとそのゲート",
  "The plot shows the active population on two channels, with the gates drawn on them. Click the gate {name} on the plot, or its card in the gate list on the right, to select it: its round handles appear.": "プロットはアクティブな集団を 2 つのチャンネルで示し、そこに描かれたゲートも表示します。プロット上のゲート{name}か、右のゲート一覧にあるそのカードをクリックして選択してください。丸いハンドルが現れます。",
  "The plot shows the active population on two channels, with the gates drawn on them. Click the gate on the plot, or its card in the gate list on the right, to select it: its round handles appear.": "プロットはアクティブな集団を 2 つのチャンネルで示し、そこに描かれたゲートも表示します。プロット上のゲートか、右のゲート一覧にあるそのカードをクリックして選択してください。丸いハンドルが現れます。",
  "The same gate on arcsinh": "同じゲートを arcsinh で",
  "Scatter opens on linear axes, and this gate was drawn on them. Under Transforms, set X and Y to Arcsinh: the gate is redrawn on the new scale, and a thin grey line appears beside its red sides.": "散乱光は線形軸で開き、このゲートはその軸で描かれました。「変換」で X と Y を Arcsinh にしてください。ゲートは新しいスケールで描き直され、赤い辺の横に細い灰色の線が現れます。",
  "Where an axis offers a choice of scale (scatter does), Transforms sets it, and a gate shown on another scale than it was drawn on bows along its sides. These axes offer none, so the tutorial goes on.": "軸がスケールを選べる場合（散乱光がそうです）、「変換」でそれを設定でき、描かれたときと別のスケールで表示されたゲートは辺が湾曲します。この軸には選択肢がないので、チュートリアルは先へ進みます。",
  "Two lines for one gate": "1 つのゲートに 2 本の線",
  "The red polygon joins the gate's vertices with straight sides, to work with. The thin grey line is the gate's own edge on these axes.": "赤いポリゴンはゲートの頂点を直線で結んだもので、操作のためのものです。細い灰色の線が、この軸でのゲート本来の境界です。",
  "They differ because the gate was drawn on linear axes and the plot is on arcsinh: a side that is straight on one scale bows on another.": "両者が異なるのは、ゲートが線形軸で描かれ、プロットが arcsinh で表示されているためです。あるスケールで直線の辺は、別のスケールでは湾曲します。",
  "Here the two coincide: these are the axes the gate was drawn on. Shown on another scale, a straight side bows.": "ここでは両者は一致しています。これがゲートの描かれた軸だからです。別のスケールで表示すると、直線の辺は湾曲します。",
  "GateLab keeps a gate in the space it was drawn in, so changing a scale redraws the gate and never moves an event in or out of it.": "GateLab はゲートを描かれた空間のまま保持します。スケールを変えるとゲートは描き直されますが、イベントがゲートを出入りすることは決してありません。",
  "The F on this gate's badge says it came from FlowJo and is tested on FlowJo's 256-channel grid, as FlowJo tests it, so GateLab takes the events FlowJo takes.": "このゲートのバッジの F は、FlowJo 由来で FlowJo の 256 チャンネルグリッド上で FlowJo と同じ方法で判定されることを示します。そのため GateLab は FlowJo と同じイベントを取ります。",
  "Move a vertex": "頂点を動かす",
  "Drag one of the gate's round handles a little way.": "ゲートの丸いハンドルの 1 つを少しドラッグしてください。",
  "Click the gate on the plot to show its round handles, then drag one a little way.": "プロット上のゲートをクリックして丸いハンドルを表示し、1 つを少しドラッグしてください。",
  "The red side follows the handle; when you let go, the count on the label changes as events cross.": "赤い辺はハンドルに追従します。離すと、イベントが境界をまたぐのに応じてラベルのカウントが変わります。",
  "The red side follows the handle; when you let go, the grey edge is drawn again through the new vertex and the count on the label changes as events cross.": "赤い辺はハンドルに追従します。離すと、灰色の境界が新しい頂点を通って描き直され、イベントが境界をまたぐのに応じてラベルのカウントが変わります。",
  "The events the gate takes": "ゲートが取るイベント",
  "In the tree on the right, click {name}: the plot keeps these axes and shows only the events inside the gate, with the gate drawn around them.": "右のツリーで{name}をクリックしてください。プロットは同じ軸のまま、ゲート内のイベントだけを、その周りにゲートを描いて表示します。",
  "the population this gate defines": "このゲートが定義する集団",
  "Along the grey edge the events end in steps: a gate from FlowJo is tested on FlowJo's 256-channel grid, so events are taken a channel at a time, and a few lie across the line.": "灰色の境界に沿ってイベントは階段状に途切れます。FlowJo 由来のゲートは FlowJo の 256 チャンネルグリッドで判定されるため、イベントはチャンネル単位で取られ、いくつかは線をまたぎます。",
  "The events end at the grey edge: that line, not the red one, is where the gate falls.": "イベントは灰色の境界で途切れます。ゲートの位置は赤い線ではなく、この線です。",
  "Move and stretch the data": "データを動かし、引き伸ばす",
  "With the arrow tool, drag the plot's background to move the data. Hold Shift while dragging to stretch it: the axes' lower ends stay where they are and the point you hold follows the pointer.": "矢印ツールでプロットの背景をドラッグするとデータが動きます。Shift を押しながらドラッグすると引き伸ばされます。軸の下端はそのままで、つかんだ点がポインターに追従します。",
  "Stretch the view along the gate's edge and the steps of the grid come into view.": "ゲートの境界に沿って表示を引き伸ばすと、グリッドの階段が見えてきます。",
  "“Fit data + gates” above the plot brings the view back.": "プロット上の「データ＋ゲートに合わせる」で表示が元に戻ります。",
  "Press Undo (⌘Z, or the arrow above the plot) to put the vertex back. Every change to the gates and the tree can be undone, and redone.": "「元に戻す」（⌘Z、またはプロット上の矢印）を押して頂点を戻してください。ゲートとツリーへの変更はすべて元に戻せ、やり直せます。",
  "The gate on its own axes": "ゲートを本来の軸で",
  "Under Transforms, set X and Y back to Linear. The grey edge straightens onto the red sides: these are the axes the gate was drawn on, and scatter opens on them. Nothing was regated; only the picture changed. That is how GateLab holds every gate: in the space it was drawn in, shown through whichever scale you choose.": "「変換」で X と Y を Linear に戻してください。灰色の境界が赤い辺にぴったり重なります。これがゲートの描かれた軸で、散乱光はこの軸で開きます。ゲーティングし直したわけではなく、見え方が変わっただけです。GateLab はすべてのゲートをこのように、描かれた空間のまま保持し、選んだスケールを通して表示します。",
  "Where an axis offers a linear scale (scatter does), Transforms sets it, and a gate drawn on linear axes then shows its sides straight. These axes offer none, so the tutorial goes on.": "軸が線形スケールを選べる場合（散乱光がそうです）、「変換」でそれを設定でき、線形軸で描かれたゲートは辺が直線で表示されます。この軸には選択肢がないので、チュートリアルは先へ進みます。",
  "The file list": "ファイル一覧",
  "The left panel lists the files. The blue one is viewed on the plot; the checkboxes choose files for pooling and for the other tabs. Click {name} to view it.": "左のパネルにファイルが並びます。青いものがプロットに表示中のファイルで、チェックボックスはプールと他のタブで使うファイルを選びます。{name}をクリックして表示してください。",
  "another file": "別のファイル",
  "Back to the first file": "最初のファイルに戻る",
  "Each file is gated by the same tree, so its counts and plots are its own. Click {name} to view it again; the tutorial goes on with it.": "各ファイルは同じツリーでゲーティングされるので、カウントとプロットはファイルごとのものです。{name}をクリックしてもう一度表示してください。チュートリアルはそのファイルで進みます。",
  "the first file": "最初のファイル",
  "The population tree": "集団のツリー",
  "The tree holds the populations, each defined by its gates, and the active one is highlighted. Clicking another makes it active: the plot shows its events, on the axes of the gates drawn on it. Click {name}.": "ツリーには、それぞれゲートで定義された集団が並び、アクティブなものが強調表示されます。別の集団をクリックするとそれがアクティブになり、プロットはそのイベントを、そこに描かれたゲートの軸で表示します。{name}をクリックしてください。",
  "another population": "別の集団",

  // ── The tree ──
  "Rename a population": "集団の名前を変える",
  "Double-click the name of {name}, type a new name and press Enter. The name is the tree's; its gates and counts stay as they are.": "{name}の名前をダブルクリックし、新しい名前を入力して Enter を押してください。名前はツリーのもので、ゲートとカウントはそのままです。",
  "a population": "集団",
  "Move a population": "集団を移動する",
  "Rows can be dragged. Dropped onto another population, a population becomes its child and its gates apply to that parent's events: drag {leaf} onto {target}; the counts follow. Dropped between rows, it only changes its place among its siblings; Option-drag copies it.": "行はドラッグできます。別の集団の上にドロップすると、その子になり、ゲートはその親のイベントに適用されます。{leaf}を{target}の上にドラッグしてください。カウントが追従します。行の間にドロップすると、兄弟の中での位置が変わるだけです。Option を押しながらドラッグするとコピーされます。",
  "a leaf": "末端の集団",
  "Rows can be dragged. Dropped onto another population, a population becomes its child and its gates apply to that parent's events; dropped between rows, it only changes its place among its siblings. Nothing here to move, so Skip.": "行はドラッグできます。別の集団の上にドロップすると、その子になり、ゲートはその親のイベントに適用されます。行の間にドロップすると、兄弟の中での位置が変わるだけです。ここには動かせるものがないので、「スキップ」を押してください。",
  "Every change to the gates and the tree can be undone: press Undo (⌘Z, or the arrow above the plot) to put the population back where it was.": "ゲートとツリーへの変更はすべて元に戻せます。「元に戻す」（⌘Z、またはプロット上の矢印）を押して集団を元の場所に戻してください。",

  // ── Gates ──
  "The gate list": "ゲート一覧",
  "Above the tree, the gates: each card names its gate, its channels, its badge and its count in the active population. Click {name} to select it; the plot switches to that gate's channels and shows it.": "ツリーの上にゲートが並びます。各カードにはゲート名、チャンネル、バッジ、アクティブな集団でのカウントが示されます。{name}をクリックして選択してください。プロットはそのゲートのチャンネルに切り替わり、ゲートを表示します。",
  "another gate": "別のゲート",
  "The axes": "軸",
  "The plot's axes are chosen on the plot itself. Click the x-axis label under the plot and pick another channel from the list.": "プロットの軸はプロット上で選びます。プロットの下の X 軸ラベルをクリックし、一覧から別のチャンネルを選んでください。",
  "Draw a gate": "ゲートを描く",
  "Choose the Rectangle tool, then drag a box on the plot. In the dialog that opens, name the gate, keep “Create population” ticked and press Create: the gate joins the list and its population the tree, under the active population.": "長方形ツールを選び、プロット上で矩形をドラッグしてください。開いたダイアログでゲートに名前を付け、「集団を作成」にチェックを入れたまま「作成」を押します。ゲートは一覧に、その集団はツリーのアクティブな集団の下に加わります。",
  "Check every file": "すべてのファイルにチェック",
  "Several files can be drawn as one cloud. First tick every file: press All above the file list, or tick the boxes one by one.": "複数のファイルを 1 つの点群として描けます。まずすべてのファイルにチェックを入れてください。ファイル一覧の上の「すべて」を押すか、1 つずつチェックします。",
  "Pool the files": "ファイルをプールする",
  "Press “Pool selected files”: the plot pools the checked files' events, and the counts on the gates and in the tree pool with it. A file whose channels differ from the viewed file's is named above the plot and left out.": "「選択したファイルをプール」を押してください。プロットはチェックしたファイルのイベントをプールし、ゲートとツリーのカウントも一緒にプールされます。表示中のファイルとチャンネルが異なるファイルは、プロットの上に名前が示されて除外されます。",
  "How the events are drawn": "イベントの描き方",
  "The Display popover above the plot sets the plot mode, how many events are drawn (All events for every one), the point size and the fonts. Open it and switch the mode to Contour.": "プロット上の「表示」ポップオーバーで、プロットのモード、描くイベント数（「全イベント」ですべて）、点の大きさ、フォントを設定します。開いて、モードを「等高線」に切り替えてください。",
  "Back to one file": "1 つのファイルに戻る",
  "Press “Return to single file” to view one file again; the checked files stay checked for the other tabs.": "「単一ファイル表示に戻る」を押して、1 つのファイルの表示に戻してください。チェックしたファイルは他のタブのためにチェックされたままです。",

  // ── Strategy ──
  "The Strategy tab": "ゲーティング戦略タブ",
  "Open the Strategy tab. It traces the active population's gating path, one plot per gate, each showing the events before that gate with its percentage.": "「ゲーティング戦略」タブを開いてください。アクティブな集団のゲーティング経路を、ゲートごとに 1 つのプロットでたどります。各プロットはそのゲートの前のイベントと、その割合を示します。",
  "The whole path": "経路全体",
  "Choose {name} in the Population list, then tick “Full path from root” to see every gate from All Events down to it.": "「集団」の一覧で{name}を選び、「ルートからの全パス」にチェックを入れると、All Events からそこまでのすべてのゲートが表示されます。",
  "a population at the end of a path": "経路の末端にある集団",
  "Back-gating": "バックゲーティング",
  "Tick “Back-gated” to overlay the final population's events on every step in orange, which shows where they sat before each gate. Pool checked files draws the steps from the pooled files; the PNG, SVG and PDF buttons export the grid.": "「バックゲート」にチェックを入れると、最終集団のイベントが各ステップにオレンジ色で重ねて描かれ、各ゲートの前にどこにあったかが分かります。「Pool checked files」はプールしたファイルからステップを描き、PNG・SVG・PDF のボタンでグリッドを書き出せます。",

  // ── Illustration ──
  "The Illustration tab": "図作成タブ",
  "Open the Illustration tab. It lays out a figure of panels: populations by files by channel pairs, with the gates drawn and the percentages labelled.": "「図作成」タブを開いてください。集団 × ファイル × チャンネルの組み合わせのパネルで図を構成し、ゲートを描き、割合をラベルで示します。",
  "Choose what to show": "表示するものを選ぶ",
  "Under Data, the Populations list sets which populations the figure shows. Tick or untick one in the list (None clears them, Leaves takes every population at the end of a path); the grid follows.": "「データ」の「集団」の一覧で、図に表示する集団を決めます。一覧でチェックを付けたり外したりしてください（「なし」ですべて解除、「Leaves」で経路の末端にあるすべての集団）。グリッドが追従します。",
  "Pooled panels": "プールしたパネル",
  "In the Style section, set Composition to Pool: each panel draws the checked files' events together, and a gate is drawn where every file holds it alike, with the pooled percentage.": "「スタイル」で「Composition」を「Pool」にしてください。各パネルはチェックしたファイルのイベントをまとめて描き、ゲートはすべてのファイルで同じ場合に、プールした割合とともに描かれます。",
  "Send a panel to Layout": "パネルをレイアウトへ送る",
  "Right-click a panel and choose “Add this panel to the Layout tab”: the Layout tab gets a plot it keeps drawing from the live gates. The same menu sends a row, a column or the selected panels, and opens a panel on the Gating tab.": "パネルを右クリックして「Add this panel to the Layout tab」を選んでください。「レイアウト」タブに、現在のゲートから描き続けるプロットが加わります。同じメニューから行・列・選択したパネルを送ったり、パネルを「ゲーティング」タブで開いたりできます。",

  // ── Layout ──
  "The Layout tab": "レイアウトタブ",
  "Open the Layout tab: a page of plots, text and figures, arranged by hand and exported as PDF, SVG or PNG.": "「レイアウト」タブを開いてください。プロット、文字、図を手で配置したページで、PDF・SVG・PNG に書き出せます。",
  "Add a plot": "プロットを加える",
  "Press “+ Biplot” to add a plot of the active population on the Gating tab's axes. The inspector on the left sets its file, population, channels and whether it pools files.": "「+ 二変量プロット」を押すと、アクティブな集団のプロットが「ゲーティング」タブの軸で加わります。左のインスペクターでファイル、集団、チャンネル、ファイルをプールするかを設定します。",
  "The sheet's style": "シートのスタイル",
  "Open Style and tick “All events”: every plot on the sheet draws every event rather than a sample of them. Iterate draws the sheet once per file, population or metadata value.": "「スタイル」を開いて「全イベント」にチェックを入れてください。シート上のすべてのプロットが、抽出したイベントではなくすべてのイベントを描きます。「反復」はシートをファイル、集団、またはメタデータの値ごとに 1 回ずつ描きます。",
  "Export the page": "ページを書き出す",
  "Press “Export PDF” to write the sheet as a PDF; the format under Page can be SVG with editable text, or PNG. The file goes to your downloads.": "「PDF を書き出す」を押すとシートが PDF として書き出されます。「ページ」の形式は、文字を編集できる SVG や PNG にもできます。ファイルはダウンロードフォルダーに保存されます。",

  // ── Plotting ──
  "The Plotting tab": "Plotting タブ",
  "Open the Plotting tab. It charts population proportions across files, grouped by a metadata column.": "「Plotting」タブを開いてください。集団の割合をファイル間で、メタデータの列でグループ化してグラフにします。",
  "Choose populations": "集団を選ぶ",
  "The Populations panel on the right chooses what is charted: the parent, and beneath it the populations whose shares of it are shown for each checked file. Tick or untick one; the chart follows.": "右の「集団」パネルで何をグラフにするかを選びます。親の集団と、その下に、チェックした各ファイルについて親に占める割合を示す集団です。チェックを付けたり外したりすると、グラフが追従します。",

  // ── Statistics ──
  "The Statistics tab": "統計タブ",
  "Open the Statistics tab: counts, percentages of parent and of total, and medians per population and file.": "「統計」タブを開いてください。集団とファイルごとのカウント、親に対する割合と全体に対する割合、中央値が表示されます。",
  "The table": "表",
  "The table covers the checked files. Press “Download CSV” to write it out, or Skip.": "表はチェックしたファイルを対象とします。「CSVをダウンロード」を押して書き出すか、「スキップ」してください。",

  // ── Metadata ──
  "The Metadata tab": "メタデータタブ",
  "Open the Metadata tab. Columns of values per file (donor, condition, day) feed the Plotting tab's grouping and the Layout tab's iteration.": "「メタデータ」タブを開いてください。ファイルごとの値の列（ドナー、条件、日）が、「Plotting」タブのグループ化と「レイアウト」タブの反復に使われます。",
  "Add a column": "列を加える",
  "Press “+ Field” to add a column, then give each file a value. The file list then offers the values as chips that check the files carrying them.": "「+ フィールド」を押して列を加え、各ファイルに値を与えてください。ファイル一覧にその値がチップとして現れ、その値を持つファイルにチェックを入れられます。",

  // ── Panel ──
  "The Panel tab": "パネルタブ",
  "Open the Panel tab: the channels of the files, their markers from the FCS, and the display names the plots use.": "「パネル」タブを開いてください。ファイルのチャンネル、FCS に記録されたマーカー、プロットで使う表示名が並びます。",
  "Display names": "表示名",
  "A display name renames a channel everywhere it is drawn without touching the file. Next to go on.": "表示名を付けると、ファイルを変えずに、描かれるすべての場所でチャンネルの名前が変わります。「次へ」で進んでください。",

  // ── Scales ──
  "The Scales tab": "スケールタブ",
  "Open the Scales tab: the range each channel's axis is drawn on, shared by every file while the scale lock is on.": "「スケール」タブを開いてください。各チャンネルの軸が描かれる範囲で、スケールのロックが有効な間はすべてのファイルで共有されます。",
  "Open the Scales tab: the range each channel's axis is drawn on, for the file you are viewing.": "「スケール」タブを開いてください。表示中のファイルについて、各チャンネルの軸が描かれる範囲です。",
  "The rows in blue": "青い行",
  "A row in blue holds a range that was adjusted after the file was read. The other rows are automatic, and their grey numbers are the range GateLab draws.": "青い行は、ファイルを読み込んだ後に調整された範囲です。他の行は自動で、灰色の数値が GateLab の描く範囲です。",
  "{names} is blue: moving, stretching or rescaling a plot on the Gating tab writes its range here, as the earlier steps of this tutorial do, and a Min or Max typed here does the same.": "{names}が青いのは、「ゲーティング」タブでプロットを動かす・引き伸ばす・スケールを変えると（このチュートリアルの前のステップがそうです）範囲がここに書き込まれるためで、ここで最小・最大を入力しても同じです。",
  "{names} are blue: moving, stretching or rescaling a plot on the Gating tab writes its range here, as the earlier steps of this tutorial do, and a Min or Max typed here does the same.": "{names}が青いのは、「ゲーティング」タブでプロットを動かす・引き伸ばす・スケールを変えると（このチュートリアルの前のステップがそうです）範囲がここに書き込まれるためで、ここで最小・最大を入力しても同じです。",
  "You have adjusted none yet: move or stretch a plot on the Gating tab, or type a Min or Max here, and its row turns blue.": "まだ何も調整されていません。「ゲーティング」タブでプロットを動かすか引き伸ばすか、ここで最小・最大を入力すると、その行が青くなります。",
  "You have adjusted none on this file yet: move or stretch a plot on the Gating tab, or type a Min or Max here, and its row turns blue.": "このファイルではまだ何も調整されていません。「ゲーティング」タブでプロットを動かすか引き伸ばすか、ここで最小・最大を入力すると、その行が青くなります。",
  "GateLab adjusted {names} itself, to keep the gates in view the first time its plot was shown.": "{names}は、そのプロットが初めて表示されたときにゲートが収まるよう、GateLab が自ら調整しました。",
  "GateLab adjusted {names} itself, to keep the gates in view the first time their plot was shown.": "{names}は、それらのプロットが初めて表示されたときにゲートが収まるよう、GateLab が自ら調整しました。",
  "{count} more": "他{count}件",
  "A range changes the view only: gates live in raw space, so no event moves in or out of one. Next to go on.": "範囲が変えるのは見え方だけです。ゲートは生の値の空間にあるので、イベントがゲートを出入りすることはありません。「次へ」で進んでください。",

  // ── Compensation ──
  "The Compensation tab": "補正タブ",
  "Open the Compensation tab: the spillover matrix the demo carries, applied to a compensated assay, with a review of each channel pair.": "「補正」タブを開いてください。デモに含まれるスピルオーバー行列が補正済みアッセイに適用され、チャンネルの組ごとに確認できます。",
  "Select a pair": "組を選ぶ",
  "Each cell of the matrix is the spill of a source channel (rows) into a receiver (columns), in percent; the diagonal is a channel into itself. Click a cell off the diagonal (the one shown holds the most spill): the Selected coefficient panel draws that pair before and after compensation, from one frozen set of events, with the residual statistics beneath.": "行列の各セルは、ソースチャンネル（行）から受け手のチャンネル（列）へのスピルをパーセントで示し、対角はチャンネル自身です。対角以外のセル（示されているのはスピルが最も大きいもの）をクリックしてください。「選択中の係数」パネルがその組を補正前後で、固定した同じイベント集合から描き、下に残差の統計を示します。",
  "Every pair at once": "すべての組を一度に",
  "Open “Global inspector” above the matrix: every pair as a small biplot, ranked by how much attention it needs, with Flagged keeping the ones you mark for follow-up. Where a matrix can be edited, the Selected coefficient panel also carries an editor: stage a value, then Apply revised matrix recomputes the compensated assay.": "行列の上の「全体ビュー」を開いてください。すべての組が小さな二変量プロットとして、注意が必要な順に並び、「フラグ済み」には後で確認するために印を付けたものが残ります。行列を編集できる場合、「選択中の係数」パネルにはエディターもあり、値を仮置きしてから「修正マトリクスを適用」で補正済みアッセイが再計算されます。",
  "Compensated and uncompensated": "補正ありと補正なし",
  "The switch at the top right of the inspector shows every plot in compensated or uncompensated data, without changing a frame. Click it to see what the matrix does to each pair, and again to come back. (The Assay menu in the header is a different thing: it sets what every tab draws from.)": "インスペクターの右上のスイッチで、すべてのプロットを補正済みデータか未補正データで、枠を変えずに表示できます。クリックして行列が各組に何をしているかを見て、もう一度クリックして戻ってください（ヘッダーの「アッセイ」メニューは別のもので、すべてのタブが何から描くかを設定します）。",

  // ── Finish ──
  "Back to Gating": "ゲーティングに戻る",
  "Open the Gating tab again.": "もう一度「ゲーティング」タブを開いてください。",
  "Saving your work": "作業を保存する",
  "The Workspace menu saves: “Save Portable Copy” writes one .gatelab file with the FCS data, the compensation and the gating inside, which opens anywhere. Save a copy, or Skip. Import brings in FlowJo and FACSChorus gates and Gating-ML; Export writes them back out.": "保存は「ワークスペース」メニューから行います。「Save Portable Copy」は FCS データ、補正、ゲーティングを含む 1 つの .gatelab ファイルを書き出し、どこでも開けます。コピーを保存するか、「スキップ」してください。「読み込み」は FlowJo や FACSChorus のゲートと Gating-ML を取り込み、「書き出し」はそれらを書き戻します。",
  "That is the tour": "以上で一巡りです",
  "You have seen every tab. The Tutorial menu starts it again from the beginning whenever you like. Bug reports and suggestions are welcome on the repository: the link at the top right, “please leave an issue at the repo”, opens its issue tracker.": "すべてのタブを見終えました。「チュートリアル」メニューからいつでも最初からやり直せます。バグ報告や提案はリポジトリへお寄せください。右上のリンク「リポジトリの Issue へお寄せください」から Issue トラッカーが開きます。",

  // ── Labels the steps point at, as the interface shows them ──
  "Pool selected": "選択したファイルをプール",
  "Return to single": "単一ファイル表示に戻る",
};
