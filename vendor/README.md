# vendor/

第三方函式庫，供 `vocab-test.html` 的「自動產生注音」功能使用。全部原樣 vendored 進 repo，讓網頁在 GitHub Pages 上可以完全 same-origin 載入，不依賴外部 CDN。

- `cnchar.min.js` / `cnchar.trad.min.js` / `cnchar.poly.min.js` — [cnchar](https://github.com/theajack/cnchar)（MIT License，見 `cnchar.LICENSE`），提供繁體中文字的拼音、多音字判斷。
- `pinyin-to-zhuyin.esm.js` — [pinyin-to-zhuyin](https://github.com/logicmason/pinyin-zhuyin)（MIT License，見 `pinyin-to-zhuyin.LICENSE`），將拼音轉換為注音符號。

多音字判斷無法保證 100% 正確，`vocab-test.html` 內有針對少數已知錯誤詞彙的修正清單（見該檔案 `POLY_FIXES`）。
