export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-tl-border bg-black">
      <div className="mx-auto flex w-full max-w-[1640px] items-center justify-between gap-4 px-5 py-2">
        <div className="flex items-center gap-3">
          <img
            src="/stl.svg"
            alt="TrustLayer logo"
            className="h-11 w-11 object-contain"
            loading="eager"
            decoding="async"
          />
          <p className="font-display text-xl font-semibold tracking-tight text-tl-text">SolanaTrustLayer</p>
        </div>
        <p className="max-w-xl text-right text-sm text-tl-muted">
          Pre-trade risk visibility for long-tail Solana tokens.
        </p>
      </div>
    </header>
  );
}
