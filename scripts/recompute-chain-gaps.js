// 一次性重算：断链计入时长由「每处固定记录间隔」改为「实际时刻差 − 正常记录间隔」。
// 用法：node scripts/recompute-chain-gaps.js          （只输出比对结果，不写库）
//      node scripts/recompute-chain-gaps.js --apply   （回填历史放行单的断链累计时长并写库）
const fs = require('fs');
const path = require('path');
const store = require('../server/store');
const coldlib = require('../server/coldlib');

const apply = process.argv.includes('--apply');
const data = store.load();
const interval = Number(data.settings.recordIntervalMinutes);

function oldChainTotal(batchId) {
  // 旧口径：每处断链固定按一个正常记录间隔计
  const rows = coldlib.effectiveRecords(data, batchId);
  let count = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (store.minutesBetween(rows[i - 1].at, rows[i].at) > Number(data.settings.chainGapMinutes)) count += 1;
  }
  return { count, total: count * interval };
}

const changedMinutes = [];
const changedVerdict = [];

for (const batch of data.batches) {
  const old = oldChainTotal(batch.id);
  const now = coldlib.chainGaps(data, batch.id);
  if (old.total !== now.totalGapMinutes) {
    changedMinutes.push({ batch, old, now });
  }
  // 放行判定里断链只看处数，处数不变结论就不会因本次口径调整而翻转；仍逐批复核一遍
  const check = coldlib.releaseCheck(data, batch);
  if (old.count !== now.gapCount) changedVerdict.push({ batch, oldCount: old.count, newCount: now.gapCount, pass: check.pass });
}

console.log('口径：每处计入时长 = 相邻记录真实时刻差 − 正常记录间隔（' + interval + ' 分钟）\n');

if (!changedMinutes.length) {
  console.log('没有断链累计时长发生变化的批次。');
} else {
  console.log('断链时长发生变化的批次：');
  for (const item of changedMinutes) {
    console.log('- ' + item.batch.code + '（' + item.batch.status + '）：' +
      item.old.total + ' 分 → ' + item.now.totalGapMinutes + ' 分（' + item.now.gapCount + ' 处）');
    item.now.gaps.forEach((g, i) => {
      console.log('    第 ' + (i + 1) + ' 处 ' + g.from + ' → ' + g.to +
        '：实际 ' + g.minutes + ' 分，旧口径计 ' + interval + ' 分，新口径计 ' + g.countedMinutes + ' 分');
    });
  }
}

console.log('');
if (!changedVerdict.length) {
  console.log('判定结论发生变化的批次：无（断链处数均未变，放行/拒收结论不变）。');
} else {
  console.log('判定结论可能变化的批次：');
  for (const item of changedVerdict) {
    console.log('- ' + item.batch.code + '：断链处数 ' + item.oldCount + ' → ' + item.newCount + '，当前判定 ' + (item.pass ? '满足' : '不满足'));
  }
}

// 回填历史放行单快照里的断链累计时长
const backfill = [];
for (const release of data.releases) {
  const now = coldlib.chainGaps(data, release.batchId);
  if (release.chainGapMinutes === undefined || Number(release.chainGapMinutes) !== now.totalGapMinutes) {
    backfill.push({ id: release.id, from: release.chainGapMinutes, to: now.totalGapMinutes });
    release.chainGapMinutes = now.totalGapMinutes;
  }
}

console.log('');
if (!backfill.length) {
  console.log('放行单无需回填。');
} else {
  console.log('放行单回填：');
  for (const b of backfill) console.log('- ' + b.id + '：' + (b.from === undefined ? '无记录' : b.from) + ' → ' + b.to + ' 分');
}

if (apply) {
  // 保留数据文件原有的 CRLF 行尾，避免整文件行尾翻转
  const text = JSON.stringify(data, null, 2).replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'db.json'), text, 'utf8');
  console.log('\n已写入 data/db.json。');
} else {
  console.log('\n（干跑，未写库；确认后加 --apply 执行）');
}
