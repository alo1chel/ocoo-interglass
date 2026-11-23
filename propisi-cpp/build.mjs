// Собирает одну страницу для Claude-артефакта: стили и скрипты встраиваются внутрь.
// Запуск: node build.mjs [путь]  →  по умолчанию dist/propisi-artifact.html
// Страница — фрагмент без <!doctype>/<html>/<head>/<body>: обёртку добавляет claude.ai при публикации.
// Для запуска в браузере с диска открывай index.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

const css = read('src/style.css');
const scripts = ['src/lessons.js', 'src/rules.js', 'src/app.js'].map((p) => {
  const js = read(p);
  if (/<\/script|<!--/i.test(js)) throw new Error(`${p}: contains "</script" or "<!--", cannot inline`);
  return `<script>\n${js}\n</script>`;
});

const fonts = 'https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap';
const page = [
  '<title>Прописи C++</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<meta name="description" content="Тренажёр C++: опиши, что хочешь запрограммировать, и печатай код поверх полупрозрачного образца с заметками на полях.">',
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  `<link rel="stylesheet" href="${fonts}">`,
  `<style>\n${css}\n</style>`,
  '<div id="app"></div>',
  ...scripts,
  ''
].join('\n');

// Путь можно передать аргументом: node build.mjs /path/to/page.html
const out = process.argv[2] || join(root, 'dist', 'propisi-artifact.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`built ${out} (${(Buffer.byteLength(page) / 1024).toFixed(1)} KB)`);
