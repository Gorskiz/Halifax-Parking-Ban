import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './App.css';

// Types
interface ParkingBanStatus {
  isActive: boolean;
  zone1Active: boolean;
  zone2Active: boolean;
  enforcementDate: string | null;
  enforcementTime: string;
  lastUpdate: Date;
  rawTitle: string;
  link: string;
}

// RSS Feed URL
const RSS_FEED_URL = 'https://www.halifax.ca/news/category/rss-feed?category=22';

// Fetch sources in order of preference:
// 1. Our own Cloudflare Worker proxy (most reliable, no rate limits)
// 2. AllOrigins as fallback (free tier, may have occasional issues)
const FETCH_SOURCES = [
  () => '/api/rss', // Local Cloudflare Worker proxy - no CORS issues
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

// Cache configuration
const CACHE_KEY = 'halifax-parking-ban-cache';
const CACHE_DURATION_MS = 120000; // 2 minutes

interface CachedData {
  status: ParkingBanStatus;
  timestamp: number;
}

function App() {
  const [status, setStatus] = useState<ParkingBanStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [countdown, setCountdown] = useState<string | null>(null);
  const [mapLightboxOpen, setMapLightboxOpen] = useState(false);

  // Accessibility refs
  const mapButtonRef = useRef<HTMLButtonElement>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement>(null);
  const mainContentRef = useRef<HTMLElement>(null);

  // Track in-flight requests to prevent duplicate fetches
  const fetchInProgressRef = useRef<Promise<ParkingBanStatus> | null>(null);

  // Cache management functions
  const getCachedData = useCallback((): ParkingBanStatus | null => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;

      const data: CachedData = JSON.parse(cached);
      const now = Date.now();

      // Check if cache is still valid
      if (now - data.timestamp < CACHE_DURATION_MS) {
        // Reconstruct Date objects (they're serialized as strings in localStorage)
        return {
          ...data.status,
          lastUpdate: new Date(data.status.lastUpdate),
        };
      }

      // Cache expired, remove it
      localStorage.removeItem(CACHE_KEY);
      return null;
    } catch (err) {
      console.warn('Failed to read cache:', err);
      return null;
    }
  }, []);

  const setCachedData = useCallback((status: ParkingBanStatus): void => {
    try {
      const data: CachedData = {
        status,
        timestamp: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('Failed to write cache:', err);
    }
  }, []);

  // Parse the RSS feed to determine parking ban status
  const parseRSSFeed = useCallback((xmlText: string): ParkingBanStatus => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    const items = xmlDoc.querySelectorAll('item');

    let latestBanItem: Element | null = null;
    let latestBanDate: Date | null = null;

    // Find the most recent parking ban related item
    items.forEach((item) => {
      const title = item.querySelector('title')?.textContent || '';
      const description = item.querySelector('description')?.textContent || '';
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const itemDate = new Date(pubDate);

      // Check if this item is about parking ban - search both title AND description
      // Halifax sometimes bundles parking ban info in "Storm impacts" posts
      const searchText = (title + ' ' + description).toLowerCase();
      const isParkingBanItem =
        searchText.includes('parking ban') ||
        searchText.includes('winter parking') ||
        searchText.includes('overnight parking');

      if (isParkingBanItem && (!latestBanDate || itemDate > latestBanDate)) {
        latestBanDate = itemDate;
        latestBanItem = item;
      }
    });

    if (!latestBanItem || !latestBanDate) {
      // No parking ban news found - assume ban is not active
      return {
        isActive: false,
        zone1Active: false,
        zone2Active: false,
        enforcementDate: null,
        enforcementTime: '1:00 AM - 6:00 AM',
        lastUpdate: new Date(),
        rawTitle: 'No recent parking ban announcements',
        link: 'https://www.halifax.ca/transportation/winter-operations/parking-ban',
      };
    }

    const title = (latestBanItem as Element).querySelector('title')?.textContent || '';
    const description = (latestBanItem as Element).querySelector('description')?.textContent || '';
    const link = (latestBanItem as Element).querySelector('link')?.textContent || '';
    const content = (title + ' ' + description).toLowerCase();

    // Determine if ban is active or lifted
    const isLifted = content.includes('lifts') || content.includes('lifted');
    const isEnforced =
      content.includes('enforced') ||
      content.includes('will be enforced') ||
      content.includes('in effect') ||
      content.includes('declared') ||
      content.includes('announcing');
    const isActive = isEnforced && !isLifted;

    // Check zone status - both zones are typically affected together in Halifax
    // But we'll parse them separately just in case
    const zone1Mentioned = content.includes('zone 1') || content.includes('zone 1 – central');
    const zone2Mentioned = content.includes('zone 2') || content.includes('zone 2 – non-central');
    const bothZones = (zone1Mentioned && zone2Mentioned) ||
      content.includes('both zone') ||
      (!zone1Mentioned && !zone2Mentioned); // If no specific zone, assume both

    // Extract date from title
    let enforcementDate: string | null = null;
    const dateMatch = title.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*(?:Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Oct\.?|Nov\.?|Dec\.?)\s*\d+/i);
    if (dateMatch) {
      enforcementDate = dateMatch[0].replace(/\./g, '');
    }

    return {
      isActive,
      zone1Active: isActive && (zone1Mentioned || bothZones),
      zone2Active: isActive && (zone2Mentioned || bothZones),
      enforcementDate,
      enforcementTime: '1:00 AM - 6:00 AM',
      lastUpdate: latestBanDate,
      rawTitle: title,
      link,
    };
  }, []);

  // Fetch with a timeout using AbortController
  const fetchWithTimeout = useCallback(async (url: string, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  // Fetch the RSS feed - race all proxies concurrently with individual timeouts
  const fetchStatus = useCallback(async () => {
    // Check cache first
    const cachedStatus = getCachedData();
    if (cachedStatus) {
      // Return cached data immediately
      setStatus(cachedStatus);
      setLoading(false);
      setError(null);
      return;
    }

    // If a fetch is already in progress, wait for it instead of starting a new one
    if (fetchInProgressRef.current) {
      try {
        const result = await fetchInProgressRef.current;
        setStatus(result);
        setLoading(false);
        setError(null);
        return;
      } catch (err) {
        // The in-progress fetch failed, continue to try again
        fetchInProgressRef.current = null;
      }
    }

    setLoading(true);
    setError(null);

    const TIMEOUT_MS = 8000; // 8 seconds per proxy

    // Create and store the fetch promise
    const fetchPromise = (async (): Promise<ParkingBanStatus> => {
      try {
        // Race all sources concurrently - first successful response wins
        const result = await Promise.any(
          FETCH_SOURCES.map(async (sourceFn) => {
            const url = sourceFn(RSS_FEED_URL);
            const response = await fetchWithTimeout(url, TIMEOUT_MS);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            // Verify we got XML, not an error JSON response
            if (text.trim().startsWith('{')) {
              throw new Error('Received JSON error instead of XML');
            }
            return parseRSSFeed(text);
          })
        );

        // Cache the successful result
        setCachedData(result);
        return result;
      } finally {
        // Clear the in-progress reference when done
        fetchInProgressRef.current = null;
      }
    })();

    fetchInProgressRef.current = fetchPromise;

    try {
      const result = await fetchPromise;
      setStatus(result);
      setLoading(false);
    } catch (err) {
      console.warn('All proxies failed:', err);
      setError('Unable to fetch parking ban status. Please try again later.');
      setLoading(false);
    }
  }, [parseRSSFeed, fetchWithTimeout, getCachedData, setCachedData]);

  // Ref to track countdown interval for cleanup
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Calculate countdown to enforcement
  useEffect(() => {
    // Clear any existing interval first
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    if (!status?.isActive) {
      setCountdown(null);
      return;
    }

    const calculateCountdown = () => {
      const now = new Date();
      // Get next 1 AM
      const next1AM = new Date();
      next1AM.setHours(1, 0, 0, 0);

      if (now.getHours() >= 1 && now.getHours() < 6) {
        // Currently in enforcement window
        setCountdown('IN EFFECT NOW');
        return;
      }

      if (now.getHours() >= 6) {
        // After 6 AM, countdown to next day 1 AM
        next1AM.setDate(next1AM.getDate() + 1);
      }

      const diff = next1AM.getTime() - now.getTime();
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setCountdown(`${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
    };

    // Initial calculation
    calculateCountdown();

    // Set up interval and store reference
    countdownIntervalRef.current = setInterval(calculateCountdown, 1000);

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [status?.isActive]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Share functionality
  const handleShare = async () => {
    const shareData = {
      title: 'Halifax Parking Ban Status',
      text: status?.isActive
        ? `Halifax parking ban is ON! Enforcement ${status.enforcementTime}`
        : 'Halifax parking ban is OFF - Park freely!',
      url: window.location.href,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(`${shareData.text}\n${shareData.url}`);
        showToast('Link copied to clipboard!');
      }
    } catch (err) {
      // User cancelled or error
      console.log('Share cancelled', err);
    }
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2500);
  };

  // Format relative time
  const formatRelativeTime = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  // Memoized snowflakes to prevent re-rendering on every state change
  const snowflakes = useMemo(() => {
    const flakes = [];
    // Use seeded-like positions based on index for consistency
    const positions = [5, 12, 18, 25, 32, 38, 45, 52, 58, 65, 72, 78, 85, 92, 8, 22, 35, 48, 62, 75];
    const durations = [10, 12, 8, 15, 11, 9, 14, 13, 10, 16, 12, 8, 11, 15, 9, 13, 10, 14, 12, 11];
    const delays = [0, 2, 4, 1, 3, 5, 2, 4, 1, 3, 0, 2, 4, 1, 3, 5, 2, 4, 1, 3];
    const sizes = [0.6, 0.8, 1.0, 0.7, 0.9, 1.1, 0.5, 0.8, 1.0, 0.6, 0.9, 0.7, 1.1, 0.8, 0.6, 1.0, 0.7, 0.9, 0.8, 1.0];

    for (let i = 0; i < 20; i++) {
      const style = {
        left: `${positions[i]}%`,
        animationDuration: `${durations[i]}s`,
        animationDelay: `${delays[i]}s`,
        fontSize: `${sizes[i]}rem`,
      };
      flakes.push(
        <span key={i} className="snowflake" style={style}></span>
      );
    }
    return flakes;
  }, []); // Empty deps - snowflakes never need to change

  // Handle lightbox keyboard navigation and focus management
  useEffect(() => {
    if (mapLightboxOpen) {
      // Focus the close button when modal opens
      lightboxCloseRef.current?.focus();

      // Trap focus within modal and handle Escape key
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setMapLightboxOpen(false);
          mapButtonRef.current?.focus();
        }

        // Simple focus trap - only close button is focusable
        if (e.key === 'Tab') {
          e.preventDefault();
          lightboxCloseRef.current?.focus();
        }
      };

      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', handleKeyDown);

      return () => {
        document.body.style.overflow = '';
        document.removeEventListener('keydown', handleKeyDown);
      };
    } else {
      document.body.style.overflow = '';
    }
  }, [mapLightboxOpen]);

  // Handle closing lightbox and restoring focus
  const closeLightbox = useCallback(() => {
    setMapLightboxOpen(false);
    // Restore focus to the button that opened the modal
    setTimeout(() => mapButtonRef.current?.focus(), 0);
  }, []);

  return (
    <div className="app">
      {/* Skip to main content link for keyboard users */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* Winter snowfall effect */}
      <div className="snowflakes" aria-hidden="true">
        {snowflakes}
      </div>

      {/* Header */}
      <header className="header" role="banner">
        <div className="container">
          <h1 className="header__logo">
            <span>Halifax Parking Ban</span>
          </h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="main" id="main-content" ref={mainContentRef} role="main">
        {loading ? (
          <div className="loading" role="status" aria-live="polite">
            <div className="loading__spinner" aria-hidden="true"></div>
            <p className="loading__text">Checking parking ban status...</p>
            <span className="visually-hidden">Loading, please wait.</span>
          </div>
        ) : error ? (
          <div className="error" role="alert" aria-live="assertive">
            <h2 className="error__title">Unable to Load Status</h2>
            <p className="error__message">{error}</p>
            <div className="error__retry">
              <button
                className="btn btn-primary"
                onClick={fetchStatus}
                aria-label="Retry loading parking ban status"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : status ? (
          <>
            {/* Status Hero */}
            <section className="status-hero" aria-labelledby="status-question">
              <h2 id="status-question" className="status-hero__question">
                Is the Halifax Overnight Parking Ban in Effect?
              </h2>

              <div className="status-display" aria-live="polite">
                <div
                  className={`status-display__badge ${status.isActive
                    ? 'status-display__badge--active'
                    : 'status-display__badge--inactive'
                    }`}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span aria-hidden="true">{status.isActive ? 'YES' : 'NO'}</span>
                  <span className="visually-hidden">
                    {status.isActive
                      ? 'Yes, the parking ban is currently active. Do not park on municipal streets between 1 AM and 6 AM.'
                      : 'No, the parking ban is not currently active. Street parking is allowed.'}
                  </span>
                </div>
              </div>

              {status.isActive && (
                <div className="enforcement-info" role="region" aria-label="Enforcement details">
                  <div className="enforcement-info__time">
                    <span>Enforcement: <time>{status.enforcementTime}</time></span>
                  </div>
                  {status.enforcementDate && (
                    <p className="enforcement-info__date">
                      Starting <time>{status.enforcementDate}</time>
                    </p>
                  )}
                </div>
              )}

              {/* Countdown when active */}
              {status.isActive && countdown && (
                <div className="countdown" role="timer" aria-live="polite" aria-atomic="true">
                  <p className="countdown__label" id="countdown-label">
                    {countdown === 'IN EFFECT NOW' ? 'Status' : 'Time Until Enforcement'}
                  </p>
                  <p className="countdown__time" aria-labelledby="countdown-label">
                    <span aria-hidden="true">{countdown}</span>
                    <span className="visually-hidden">
                      {countdown === 'IN EFFECT NOW'
                        ? 'The parking ban is in effect now'
                        : `Time until enforcement: ${countdown.replace(/:/g, ' hours, ').replace(/, ([^,]*)$/, ' minutes, $1 seconds')}`}
                    </span>
                  </p>
                </div>
              )}
            </section>

            {/* Zone Status */}
            <section className="zones" aria-labelledby="zones-title">
              <h2 id="zones-title" className="zones__title">Zone Status</h2>
              <div className="zones__grid" role="list">
                {/* Zone 1 */}
                <article className="zone-card" role="listitem" aria-labelledby="zone1-name">
                  <p className="zone-card__label">Zone 1</p>
                  <h3 id="zone1-name" className="zone-card__name">Central Halifax</h3>
                  <div
                    className={`zone-card__status ${status.zone1Active
                      ? 'zone-card__status--active'
                      : 'zone-card__status--inactive'
                      }`}
                    role="status"
                    aria-label={`Zone 1 Central Halifax: ${status.zone1Active ? 'Parking ban is active' : 'No parking ban'}`}
                  >
                    <span
                      className={`zone-card__status-dot ${status.zone1Active
                        ? 'zone-card__status-dot--active'
                        : 'zone-card__status-dot--inactive'
                        }`}
                      aria-hidden="true"
                    ></span>
                    {status.zone1Active ? 'Ban Active' : 'No Ban'}
                  </div>
                  <p className="zone-card__description">
                    Downtown Halifax, Peninsula & Central Dartmouth
                  </p>
                </article>

                {/* Zone 2 */}
                <article className="zone-card" role="listitem" aria-labelledby="zone2-name">
                  <p className="zone-card__label">Zone 2</p>
                  <h3 id="zone2-name" className="zone-card__name">Non-Central</h3>
                  <div
                    className={`zone-card__status ${status.zone2Active
                      ? 'zone-card__status--active'
                      : 'zone-card__status--inactive'
                      }`}
                    role="status"
                    aria-label={`Zone 2 Non-Central: ${status.zone2Active ? 'Parking ban is active' : 'No parking ban'}`}
                  >
                    <span
                      className={`zone-card__status-dot ${status.zone2Active
                        ? 'zone-card__status-dot--active'
                        : 'zone-card__status-dot--inactive'
                        }`}
                      aria-hidden="true"
                    ></span>
                    {status.zone2Active ? 'Ban Active' : 'No Ban'}
                  </div>
                  <p className="zone-card__description">
                    Bedford, Sackville, Cole Harbour & Surrounding Areas
                  </p>
                </article>
              </div>

              {/* Zone Map Section */}
              <div className="zone-map-section">
                <p className="zone-map-section__label" id="zone-map-label">Not sure which zone you're in?</p>
                <button
                  ref={mapButtonRef}
                  className="zone-map-card"
                  onClick={() => setMapLightboxOpen(true)}
                  aria-label="View zone map in full screen. Opens a modal dialog."
                  aria-describedby="zone-map-label"
                  aria-haspopup="dialog"
                >
                  <img
                    src="https://cdn.halifax.ca/sites/default/files/pages/in-content/2022-12/winter-parking-ban-zone-map-zone-1-and-zone-2.jpg"
                    alt="Halifax Winter Parking Ban Zone Map. Zone 1 in red covers downtown Halifax peninsula and central Dartmouth. Zone 2 in blue covers Bedford, Sackville, Cole Harbour and surrounding areas."
                    className="zone-map-card__image"
                    loading="lazy"
                  />
                  <div className="zone-map-card__overlay" aria-hidden="true">
                    <span className="zone-map-card__overlay-text">Tap to enlarge</span>
                  </div>
                </button>
                <p className="zone-map-section__source">
                  Source:{' '}
                  <a
                    href="https://www.halifax.ca/transportation/winter-operations/parking-ban"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Halifax.ca parking ban information (opens in new tab)"
                  >
                    Halifax.ca
                    <span className="visually-hidden"> (opens in new tab)</span>
                  </a>
                </p>
              </div>
            </section>

            {/* Info Section */}
            <section className="info-section" aria-labelledby="info-title">
              <div className="info-card">
                <h3 id="info-title" className="info-card__title">
                  What You Need to Know
                </h3>
                <div className="info-card__content">
                  <p>
                    The overnight winter parking ban is enforced from{' '}
                    <strong className="info-card__highlight"><time>1:00 AM</time> to <time>6:00 AM</time></strong>{' '}
                    during winter weather events to allow crews to clear streets.
                  </p>
                  <p>
                    Vehicles parked on municipal streets during enforcement may be{' '}
                    <strong className="info-card__highlight">ticketed ($80+ fine)</strong>{' '}
                    or <strong className="info-card__highlight">towed</strong>.
                  </p>
                  <p>
                    The ban applies to all municipal streets in the affected zones.
                    Private parking lots and driveways are not affected.
                  </p>
                </div>
              </div>
            </section>

            {/* Share Button */}
            <section className="share-section" aria-label="Share parking ban status">
              <button
                className="share-button"
                onClick={handleShare}
                aria-label={status.isActive
                  ? 'Share that the parking ban is active'
                  : 'Share that the parking ban is not active'}
              >
                Share Status
              </button>
            </section>

            {/* Last Updated */}
            <p className="last-updated" role="contentinfo">
              <span>Last updated: <time dateTime={status.lastUpdate.toISOString()}>{formatRelativeTime(status.lastUpdate)}</time></span>
              {' · '}
              <a
                href={status.link || 'https://www.halifax.ca/transportation/winter-operations/parking-ban'}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View source on Halifax.ca (opens in new tab)"
              >
                View source
                <span className="visually-hidden"> (opens in new tab)</span>
              </a>
            </p>
          </>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="footer" role="contentinfo">
        <div className="container">
          <nav aria-label="Footer links" className="footer__nav">
            <p className="footer__content">
              Data from{' '}
              <a
                href="https://www.halifax.ca"
                target="_blank"
                rel="noopener noreferrer"
                className="footer__link"
                aria-label="Halifax.ca (opens in new tab)"
              >
                Halifax.ca
                <span className="visually-hidden"> (opens in new tab)</span>
              </a>
              <span className="footer__divider" aria-hidden="true">·</span>
              <a
                href="https://github.com/Gorskiz/Halifax-Parking-Ban"
                target="_blank"
                rel="noopener noreferrer"
                className="footer__link"
                aria-label="View source code on GitHub (opens in new tab)"
              >
                Open Source
                <span className="visually-hidden"> (opens in new tab)</span>
              </a>
            </p>
          </nav>
          <p className="footer__disclaimer">
            <strong>Disclaimer:</strong> Not an official Halifax Regional Municipality website. Community built and maintained.
          </p>
        </div>
      </footer>

      {/* Zone Map Lightbox Modal */}
      {mapLightboxOpen && (
        <div
          className="lightbox"
          onClick={closeLightbox}
          role="dialog"
          aria-modal="true"
          aria-labelledby="lightbox-title"
          aria-describedby="lightbox-description"
        >
          <h2 id="lightbox-title" className="visually-hidden">Zone Map - Enlarged View</h2>
          <p id="lightbox-description" className="visually-hidden">
            Press Escape or click Close to return to the main page.
          </p>
          <button
            ref={lightboxCloseRef}
            className="lightbox__close"
            onClick={closeLightbox}
            aria-label="Close zone map modal"
          >
            Close <span className="visually-hidden">(Press Escape)</span>
          </button>
          <img
            src="https://cdn.halifax.ca/sites/default/files/pages/in-content/2022-12/winter-parking-ban-zone-map-zone-1-and-zone-2.jpg"
            alt="Halifax Winter Parking Ban Zone Map. Zone 1 in red covers downtown Halifax peninsula and central Dartmouth. Zone 2 in blue covers Bedford, Sackville, Cole Harbour and surrounding areas. Press Escape to close."
            className="lightbox__image"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Toast Notification */}
      <div
        className={`toast ${toastVisible ? 'toast--visible' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {toastMessage}
      </div>
    </div>
  );
}

export default App;
