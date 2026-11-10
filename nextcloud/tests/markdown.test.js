// node tests/markdown.test.js
const assert = require('node:assert/strict')
const md = require('../js/markdown.js')
let n = 0
const eq = (a, b, name) => { assert.deepEqual(a, b, name); n++ }
const T = (v) => ({ t: 'text', v })

eq(md.parse('# Title'), [{ t: 'h', level: 1, c: [T('Title')] }], 'heading')
eq(md.parse('## Sub ##'), [{ t: 'h', level: 2, c: [T('Sub')] }], 'closing hashes')
eq(md.parse('#nospace'), [{ t: 'p', c: [T('#nospace')] }], 'hashtag is text')
eq(md.parse('a **b** *c* ~~d~~ `e`')[0].c, [T('a '), { t: 'strong', c: [T('b')] }, T(' '), { t: 'em', c: [T('c')] }, T(' '), { t: 'del', c: [T('d')] }, T(' '), { t: 'code', v: 'e' }], 'inline')
eq(md.parse('snake_case_name and 2*3*4')[0].c, [T('snake_case_name and 2*3*4')], 'no accidental italics')
eq(md.parse('__bold__ _it_')[0].c, [{ t: 'strong', c: [T('bold')] }, T(' '), { t: 'em', c: [T('it')] }], 'underscores')
eq(md.parse('line one\nline two')[0].c, [T('line one'), { t: 'br' }, T('line two')], 'line breaks kept')
eq(md.parse('a\n\nb').length, 2, 'paragraphs')
eq(md.parse('\\*not\\* italic')[0].c, [T('*not* italic')], 'escapes')

// links: only web addresses
eq(md.parse('[site](https://example.com/a?b=1)')[0].c, [{ t: 'link', href: 'https://example.com/a?b=1', c: [T('site')] }], 'link')
for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:x', '//evil.com', '/relative', ' javascript:alert(1)']) {
	const nodes = md.parse(`[click](${bad})`)[0].c
	assert.ok(!JSON.stringify(nodes).includes('"link"'), 'no link for ' + bad); n++
}
eq(md.parse('see https://nextcloud.com/x, then')[0].c, [T('see '), { t: 'link', href: 'https://nextcloud.com/x', c: [T('https://nextcloud.com/x')] }, T(', then')], 'bare address')
eq(md.parse('<script>alert(1)</script> <img src=x onerror=alert(1)>')[0].c, [T('<script>alert(1)</script> <img src=x onerror=alert(1)>')], 'HTML stays text')
eq(md.safeUrl('https://a.b/"onmouseover="x'), null, 'quotes refused in addresses')

// lists and checklists
const list = md.parse('- one\n- [ ] two\n- [x] three')[0]
eq(list.t, 'ul', 'ul')
eq(list.items.map((i) => [i.task, i.line]), [[null, 0], [false, 1], [true, 2]], 'tasks and their lines')
const ol = md.parse('3. c\n4. d')[0]
eq([ol.t, ol.start, ol.items.length], ['ol', 3, 2], 'numbered list keeps its start')
const nested = md.parse('- parent\n  - [ ] child\n  - [x] child 2\n- next')[0]
eq(nested.items.length, 2, 'two top items')
eq(nested.items[0].b[0].items.map((i) => [i.task, i.line]), [[false, 1], [true, 2]], 'nested checklist lines')
eq(md.toggleTask('- a\n  - [ ] child', 1, true), '- a\n  - [x] child', 'tick nested')
eq(md.toggleTask('1. [x] done', 0, false), '1. [ ] done', 'untick')
eq(md.toggleTask('no list', 0, true), 'no list', 'only checklist lines change')
eq(md.taskCount('- [x] a\n- [ ] b\n  - [X] c\ntext [ ] no'), [2, 3], 'count')
const after = md.parse('text before\n- [ ] item')
eq(after.map((b) => b.t), ['p', 'ul'], 'list after a paragraph line')
eq(after[1].items[0].line, 1, 'line number after a paragraph')

// other blocks
eq(md.parse('```js\nconst a = "<b>"\n```')[0], { t: 'code', lang: 'js', v: 'const a = "<b>"' }, 'code block')
eq(md.parse('> quoted\n> **two**')[0].t, 'quote', 'quote')
eq(md.parse('---')[0], { t: 'hr' }, 'separator')
eq(md.parse('```\nnever closed').length, 1, 'unclosed fence')

// deep nesting and long input don't blow up
assert.ok(md.parse('>'.repeat(5000) + ' x').length >= 1); n++
assert.ok(md.parse('*'.repeat(10000)).length >= 1); n++
assert.ok(md.parse('['.repeat(3000) + 'a](https://x.y)').length >= 1); n++
const t0 = Date.now(); md.parse('**a '.repeat(4000)); md.parse('_a '.repeat(6000)); md.parse('`'.repeat(20000))
assert.ok(Date.now() - t0 < 1500, 'fast on hostile input: ' + (Date.now() - t0) + 'ms'); n++

// plain titles (Done, lists)
eq(md.plainTitle('# **Call** the [supervisor](https://x.y)\nmore'), 'Call the supervisor', 'title')
eq(md.plainTitle('- [ ] Buy *paper*'), 'Buy paper', 'checklist title')
eq(md.plainTitle('> `code` and ~~old~~'), 'code and old', 'quote title')
eq(md.plainTitle('x'.repeat(200)).length, 120, 'title length')
console.log(`markdown: all ${n} checks passed`)
