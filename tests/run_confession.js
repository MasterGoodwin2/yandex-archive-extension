// Самопроверка режима «Исповедные ведомости»: node tests/run_confession.js
// Сверяет JS-версию (confession-rows.js) с результатом Python-скрипта навыка на тех же страницах
// (tests/confession_expected_python.json) и проверяет устойчивость к разрешению скана.
const fs = require('fs'), path = require('path');
const CR = require('../confession-rows.js');
const dir = path.join(__dirname, 'fixtures');
const exp = JSON.parse(fs.readFileSync(path.join(__dirname, 'confession_expected_python.json'), 'utf8'));
const key = (rep) => rep.persons.map((p) => [p.half, p.sex, p.no, p.age, p.yard_mark || '', p.block_id, p.person_text].join('|'));
const scaled = (n, k) => Object.assign({}, n, {
  originalImageSize: { width: Math.round(n.originalImageSize.width * k), height: Math.round(n.originalImageSize.height * k) },
  joinedTextBlocks: n.joinedTextBlocks.map((j) => ({ id: j.id, points: j.points.map((p) => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) })) })),
});
let ok = true;
for (const f of fs.readdirSync(dir).filter((x) => /^confession_.*_fixture\.json$/.test(x)).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const node = d.props.pageProps.currentNode;
  const rep = CR.process(node);
  const k = key(rep);
  const same = JSON.stringify(k) === JSON.stringify(exp[f]);
  ok = ok && same;
  console.log(`${f}: людей ${rep.persons.length}, флаги ${JSON.stringify(rep.flags)} — ${same ? 'совпадает с Python' : 'РАСХОДИТСЯ с Python'}`);
  if (!same) {
    const e = exp[f] || [];
    for (let i = 0; i < Math.max(e.length, k.length); i++) if (e[i] !== k[i]) { console.log('   py:', e[i], '\n   js:', k[i]); break; }
  }
  for (const s of [0.5, 0.75, 1.5, 2]) {
    const r = key(CR.process(scaled(node, s)));
    const share = r.filter((x) => k.includes(x)).length / Math.max(k.length, 1);
    const good = share === 1 && r.length === k.length;
    ok = ok && good;
    console.log(`    масштаб x${s}: совпадает ${(share * 100).toFixed(0)}% ${good ? 'OK' : 'ОШИБКА'}`);
  }
}
console.log('ИТОГ:', ok ? 'OK' : 'ЕСТЬ РАСХОЖДЕНИЯ');
process.exit(ok ? 0 : 1);
