import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}', './shared/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens driven by CSS variables (see globals.css)
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        elevated: 'rgb(var(--c-elevated) / <alpha-value>)',
        border: 'rgb(var(--c-border) / <alpha-value>)',
        'border-strong': 'rgb(var(--c-border-strong) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        faint: 'rgb(var(--c-faint) / <alpha-value>)',
        brand: {
          50: '#EEF0FF',
          100: '#E0E3FF',
          200: '#C7CBFF',
          300: '#A5A9FF',
          400: '#8481FB',
          500: '#6D5EF5',
          600: '#5B48E0',
          700: '#4B38BF',
          800: '#3D2F99',
          900: '#332A7A'
        },
        sky: {
          400: '#38BDF8',
          500: '#22B8FF',
          600: '#0C9BE0'
        },
        coral: {
          400: '#FF8A7A',
          500: '#FF6B5E',
          600: '#F04E40'
        },
        mint: {
          400: '#3DDC97',
          500: '#22C77D',
          600: '#12A866'
        },
        gold: {
          400: '#FFC53D',
          500: '#F5A623'
        }
      },
      fontFamily: {
        // System stack on purpose. Inter is not downloaded, so type stays
        // consistent offline and on first paint. A local Inter install still matches.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif'
        ],
        display: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif'
        ]
      },
      spacing: {
        // Used by existing icon classes (h-4.5). Default Tailwind has no 4.5 step.
        4.5: '1.125rem'
      },
      borderRadius: {
        '2xl': '1.125rem',
        '3xl': '1.5rem',
        '4xl': '2rem'
      },
      boxShadow: {
        soft: '0 2px 12px -2px rgb(16 20 50 / 0.08), 0 1px 3px rgb(16 20 50 / 0.06)',
        card: '0 8px 28px -6px rgb(16 20 50 / 0.12), 0 2px 8px rgb(16 20 50 / 0.06)',
        pop: '0 16px 48px -8px rgb(16 20 50 / 0.22)',
        glow: '0 0 0 1px rgb(109 94 245 / 0.25), 0 12px 40px -12px rgb(109 94 245 / 0.45)'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' }
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        },
        'slide-in-left': {
          from: { opacity: '0', transform: 'translateX(-24px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' }
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' }
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' }
        },
        'typing-dot': {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.5' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' }
        },
        'ring-expand': {
          from: { transform: 'scale(0.9)', opacity: '1' },
          to: { transform: 'scale(1.6)', opacity: '0' }
        }
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease-out',
        'fade-up': 'fade-up 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        'scale-in': 'scale-in 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-right': 'slide-in-right 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-left': 'slide-in-left 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        float: 'float 5s ease-in-out infinite',
        shimmer: 'shimmer 1.8s linear infinite',
        'typing-dot': 'typing-dot 1.1s ease-in-out infinite',
        'ring-expand': 'ring-expand 1.4s ease-out infinite'
      },
      screens: {
        xs: '380px'
      }
    }
  },
  plugins: []
};

export default config;
