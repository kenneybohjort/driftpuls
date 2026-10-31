/** Tailwind-inställningar. Här ändrar du färger, typsnitt m.m. */
const v = (n) => `rgb(var(--c-${n}) / <alpha-value>)`; // färgerna definieras i src/input.css (ljust/mörkt tema)

module.exports = {
  darkMode: 'class',
  // Tailwind skapar bara de klasser som hittas i dessa filer.
  content: ['./public/index.html', './public/login.html', './public/admin.js', './public/login.js', './server.js'],
  theme: {
    extend: {
      colors: {
        // Varumärkesgrön: bg-brand, border-brand, hover:bg-brand-dark ...
        brand: { DEFAULT: '#637c17', light: '#82a320', dark: '#4f6312' },
        // Temafärger (byter värde mellan ljust och mörkt)
        page: v('page'), card: v('card'), inset: v('inset'),
        line: v('line'), 'line-strong': v('line-strong'),
        soft: v('soft'), 'soft-hover': v('soft-hover'),
        fg: v('fg'), fg2: v('fg2'), muted: v('muted'), faint: v('faint'),
        accent: v('accent'), danger: v('danger'), info: v('info'),
      },
    },
  },
};
