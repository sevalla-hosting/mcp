export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sevalla MCP</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <style>
      .font-display {
        font-family: 'Funnel Display', sans-serif;
      }

      .font-body {
        font-family: 'Manrope', sans-serif;
      }

      .animate-reveal {
        animation: reveal 700ms ease-out both;
      }

      .animate-float {
        animation: float 7s ease-in-out infinite;
      }

      @keyframes reveal {
        0% {
          opacity: 0;
          transform: translateY(14px) scale(0.98);
        }

        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      @keyframes float {
        0%,
        100% {
          transform: translateY(0);
        }

        50% {
          transform: translateY(-8px);
        }
      }
    </style>
  </head>
  <body class="min-h-screen bg-white font-body text-stone-900 antialiased">
    <main class="relative flex min-h-screen items-center justify-center px-6 py-12">
      <section class="relative w-full max-w-2xl animate-reveal rounded-3xl border border-stone-200 bg-white p-8 shadow-2xl md:p-12">
        <div class="mx-auto mb-8 w-24 animate-float md:w-28" aria-label="Sevalla logo">
          <svg viewBox="0 0 560 560" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
            <rect width="559.266" height="559.266" rx="110" fill="#FA7216" />
            <path
              d="M157.293 182.779H216.763V220.895C216.763 229.391 216.763 247.99 232.116 247.99H342.406L392.546 298.85C392.987 299.451 393.653 300.017 394.429 300.677C397.361 303.17 401.875 307.009 401.875 319.171V377.034H342.406V338.918C342.406 330.422 342.406 311.823 327.053 311.823H216.18L166.622 260.963C166.181 260.362 165.516 259.796 164.739 259.136C161.808 256.643 157.293 252.804 157.293 240.642V182.779Z"
              fill="#F9F5F3"
            />
            <path d="M216.763 116.878V182.779L342.697 182.778V116.878H216.763Z" fill="#F9F5F3" />
            <path d="M216.18 377.034V442.934H342.697V377.034H216.18Z" fill="#F9F5F3" />
            <path d="M342.697 182.779L342.406 247.99H401.972L401.875 182.779H342.697Z" fill="#F9F5F3" />
            <path d="M157.293 311.823V377.034H216.18L216.18 311.823H157.293Z" fill="#F9F5F3" />
          </svg>
        </div>
        <h1 class="text-center font-display text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">
          Welcome to Sevalla MCP
        </h1>
        <p class="mx-auto mt-5 max-w-xl text-center text-base leading-relaxed text-stone-600 md:text-lg">
          Deploy to Sevalla hands-free with coding agents.
        </p>
        <p class="mx-auto max-w-xl text-center text-base leading-relaxed text-stone-600 md:text-lg">
          Our MCP helps execute platform actions,<br/> so shipping becomes conversational.
        </p>
        <div class="mt-8 flex justify-center">
          <a
            href="https://docs.sevalla.com/quick-starts/coding-agents/overview"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center justify-center rounded-xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
          >
            Get started
          </a>
        </div>
      </section>
    </main>
  </body>
</html>
`
