# vendor/

第三方函式庫，供 `vocab-test.html` 的「自動產生注音」功能使用。全部原樣 vendored 進 repo，讓網頁在 GitHub Pages 上可以完全 same-origin 載入，不依賴外部 CDN。

- `cnchar.min.js` / `cnchar.trad.min.js` / `cnchar.poly.min.js` — [cnchar](https://github.com/theajack/cnchar)（MIT License，見 `cnchar.LICENSE`），提供繁體中文字的拼音、多音字判斷。
- `pinyin-to-zhuyin.esm.js` — [pinyin-to-zhuyin](https://github.com/logicmason/pinyin-zhuyin)（MIT License，見 `pinyin-to-zhuyin.LICENSE`），將拼音轉換為注音符號。
- `lxgw-wenkai-tc/` — [LXGW WenKai TC](https://github.com/lxgw/LxgwWenkaiTC)（SIL Open Font License 1.1，見 `lxgw-wenkai-tc/LICENSE`）標楷體風格開源字型，透過 [Fontsource](https://fontsource.org/) 打包、依 Unicode 範圍切成多個小檔案，瀏覽器只會下載頁面實際用到的部分。不依賴使用者電腦上是否裝有「標楷體」/「DFKai-SB」等系統字型，確保列印出來的字體樣式一致。

多音字判斷無法保證 100% 正確，`vocab-test.html` 內有針對少數已知錯誤詞彙的修正清單（見該檔案 `POLY_FIXES`）。
