/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './index.jsx',
    './App.jsx',
    './components/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef8ff',
          500: '#0b6bcb',
          600: '#0a5fb4',
          700: '#084f96',
          900: '#0a2f57'
        }
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
};
