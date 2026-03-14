import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EMBEDDED_CHECKOUT_IFRAME_ALLOW_STRING,
  EMBEDDED_CHECKOUT_IFRAME_SANDBOX_LIST,
  getEmbeddedCheckoutIframeUrl,
  onWhopCheckoutMessage,
  parseSetupFutureUsage
} from '@whop/checkout/util';

const EMBED_SANDBOX = EMBEDDED_CHECKOUT_IFRAME_SANDBOX_LIST.join(' ');

export default function WhopCheckoutFrame({
  sessionId,
  email,
  returnUrl,
  stateId,
  onComplete,
  onStateChange
}) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(560);

  const src = useMemo(
    () =>
      getEmbeddedCheckoutIframeUrl(
        undefined,
        'dark',
        sessionId,
        undefined,
        false,
        true,
        undefined,
        { container: { paddingY: 0 } },
        email ? { email } : undefined,
        { accentColor: '#85f8b8', highContrast: true },
        false,
        false,
        Boolean(email),
        Boolean(email),
        false,
        undefined,
        parseSetupFutureUsage('off_session'),
        returnUrl,
        stateId
      ),
    [email, returnUrl, sessionId, stateId]
  );

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) {
      return undefined;
    }

    return onWhopCheckoutMessage(frame, (message) => {
      switch (message.event) {
        case 'resize':
          setHeight(message.height);
          break;
        case 'center':
          frame.scrollIntoView({ block: 'center', inline: 'center' });
          break;
        case 'complete':
          onComplete?.();
          break;
        case 'state':
          onStateChange?.(message.state);
          break;
        default:
          break;
      }
    });
  }, [onComplete, onStateChange, sessionId]);

  return (
    <iframe
      key={src}
      ref={iframeRef}
      allow={EMBEDDED_CHECKOUT_IFRAME_ALLOW_STRING}
      sandbox={EMBED_SANDBOX}
      title="Whop Embedded Checkout"
      src={src}
      style={{
        border: 'none',
        width: '100%',
        height: `${height}px`,
        overflow: 'hidden'
      }}
    />
  );
}
