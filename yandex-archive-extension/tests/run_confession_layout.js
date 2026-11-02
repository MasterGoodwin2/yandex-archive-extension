// Прогон режима «Исповедные ведомости» через тот же путь, что в расширении (Layout.processConfessionNode),
// и печать ячеек листа «Люди». Запуск: node tests/run_confession_layout.js
const fs = require('fs'), path = require('path');
global.Logic = require('../logic.js');
global.ConfessionRows = require('../confession-rows.js');
global.RevisionRows = require('../revision-rows.js');
const Layout = require('../layout.js');
const dir = path.join(__dirname, 'fixtures');
for (const f of fs.readdirSync(dir).filter((x) => /^confession_.*_fixture\.json$/.test(x)).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).props.pageProps;
  const year = parseInt(f.match(/_(\d{4})_/)[1], 10);
  const st = Layout.newState(), out = [];
  const how = Layout.processConfessionNode(d.currentNode, { url: d.url, page: d.currentNode.sheetPageNumber, year }, st, 'confession', out);
  Layout.finish(st, out);
  console.log(`\n===== ${f} (${year}): ${how}\nпроверка: ${st.checks[d.currentNode.sheetPageNumber]}`);
  st.rows.slice(0, 25).forEach((r) => console.log(`${r.settlement} | двор ${r.yard} | ${r.person} | ${r.sex} | ${r.no} | ${r.age} | ${(r.notes || []).join('; ')}`));
  console.log(`... всего дворов ${out.length}, строк ${st.rows.length}`);
}
