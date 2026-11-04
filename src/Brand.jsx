export default function Brand({ size = 24, wordmark = true }) {
  return <span className="hardviser-brand" role={wordmark ? undefined : 'img'} aria-label={wordmark ? undefined : 'Hardviser'}>
    <span className="hardviser-brand__mark" aria-hidden="true" style={{ width: size, height: size }}/>
    {wordmark && <span className="hardviser-brand__wordmark">hardviser</span>}
  </span>;
}
