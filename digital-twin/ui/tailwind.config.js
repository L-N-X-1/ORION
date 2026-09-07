/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm graphite instrument chassis — deliberately not slate/indigo.
        void: '#0B0A09',
        panel: '#121110',
        panel2: '#171614',
        raise: '#1E1C19',
        line: '#262320',
        line2: '#332F2A',
        ink: '#F0EAE0',
        ink2: '#9E978B',
        ink3: '#6A645B',
        // Sodium amber = attention / interaction. Never used for "all good".
        amber: '#FFB01F',
        amber2: '#C98A1A',
        amberwash: '#251A05',
        // Status + chart families.
        teal: '#3FBFA8',
        coral: '#FF5F52',
        sand: '#D9C48F',
        steel: '#7E93A8',
        lime: '#A8C246',
        clay: '#C97B5A',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '2px',
        md: '3px',
        lg: '4px',
      },
      fontSize: {
        micro: ['10px', { lineHeight: '14px', letterSpacing: '0.18em' }],
        tiny: ['11px', { lineHeight: '16px' }],
      },
      keyframes: {
        pulseled: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.25' },
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        pulseled: 'pulseled 1.6s ease-in-out infinite',
        sweep: 'sweep 2.2s linear infinite',
      },
    },
  },
  plugins: [],
}
