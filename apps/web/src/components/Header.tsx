interface HeaderProps {
  onOpenMethodology: () => void;
  apiHealthHref: string;
}

export function Header({ onOpenMethodology, apiHealthHref }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-tl-border bg-black">
      <div className="mx-auto flex w-full max-w-[1640px] items-center justify-between gap-4 px-5 py-2">
        <div className="flex items-center gap-3">
          <img
            src="/stl.svg"
            alt="TrustLayer logo"
            className="h-10 w-10 object-contain"
            loading="eager"
            decoding="async"
          />
          <p className="font-display text-xl font-semibold tracking-tight text-tl-text">SolanaTrustLayer</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <p className="hidden max-w-xl text-right text-sm text-tl-muted xl:block">
            Pre-trade risk visibility for long-tail Solana tokens.
          </p>
          <button
            type="button"
            onClick={onOpenMethodology}
            className="border border-tl-border bg-black px-2 py-1 text-xs font-semibold text-zinc-200 transition-colors duration-150 hover:bg-[#101010]"
          >
            Methodology
          </button>
          <a
            href={apiHealthHref}
            target="_blank"
            rel="noreferrer"
            className="border border-tl-border bg-black px-2 py-1 text-xs font-semibold text-zinc-200 transition-colors duration-150 hover:bg-[#101010]"
          >
            API
          </a>
        </div>
      </div>
    </header>
  );
}
