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

// RSS Feed URL (using a CORS proxy for client-side fetching)
const RSS_FEED_URL = 'https://www.halifax.ca/news/category/rss-feed?category=22';
// CORS proxy options
const CORS_PROXIES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

function App() {
  const [status, setStatus] = useState<ParkingBanStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [countdown, setCountdown] = useState<string | null>(null);
  const [mapLightboxOpen, setMapLightboxOpen] = useState(false);

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
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const itemDate = new Date(pubDate);

      // Check if this item is about parking ban
      const isParkingBanItem =
        title.toLowerCase().includes('parking ban') ||
        title.toLowerCase().includes('winter parking');

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
    const isEnforced = content.includes('enforced') || content.includes('will be enforced');
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

  // Fetch the RSS feed
  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);

    for (const proxyFn of CORS_PROXIES) {
      try {
        const response = await fetch(proxyFn(RSS_FEED_URL));
        if (!response.ok) continue;

        const xmlText = await response.text();
        const parsedStatus = parseRSSFeed(xmlText);
        setStatus(parsedStatus);
        setLoading(false);
        return;
      } catch (err) {
        console.warn('Proxy failed, trying next...', err);
        continue;
      }
    }

    // All proxies failed
    setError('Unable to fetch parking ban status. Please try again later.');
    setLoading(false);
  }, [parseRSSFeed]);

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

  return (
    <div className="app">
      {/* Winter snowfall effect */}
      <div className="snowflakes" aria-hidden="true">
        {snowflakes}
      </div>

      {/* Header */}
      <header className="header">
        <div className="container">
          <div className="header__logo">
            <span>Halifax Parking Ban</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="main">
        {loading ? (
          <div className="loading">
            <div className="loading__spinner" aria-label="Loading"></div>
            <p className="loading__text">Checking parking ban status...</p>
          </div>
        ) : error ? (
          <div className="error" role="alert">
            <h2 className="error__title">Unable to Load Status</h2>
            <p className="error__message">{error}</p>
            <div className="error__retry">
              <button className="btn btn-primary" onClick={fetchStatus}>
                Try Again
              </button>
            </div>
          </div>
        ) : status ? (
          <>
            {/* Status Hero */}
            <section className="status-hero" aria-live="polite">
              <p className="status-hero__question">
                Is the Halifax Overnight Parking Ban in Effect?
              </p>

              <div className="status-display">
                <div
                  className={`status-display__badge ${status.isActive
                    ? 'status-display__badge--active'
                    : 'status-display__badge--inactive'
                    }`}
                  role="status"
                  aria-label={status.isActive ? 'Parking ban is active' : 'Parking ban is not active'}
                >
                  {status.isActive ? 'YES' : 'NO'}
                </div>
              </div>

              {status.isActive && (
                <div className="enforcement-info">
                  <div className="enforcement-info__time">
                    <span>Enforcement: {status.enforcementTime}</span>
                  </div>
                  {status.enforcementDate && (
                    <p className="enforcement-info__date">
                      Starting {status.enforcementDate}
                    </p>
                  )}
                </div>
              )}

              {/* Countdown when active */}
              {status.isActive && countdown && (
                <div className="countdown">
                  <p className="countdown__label">
                    {countdown === 'IN EFFECT NOW' ? 'Status' : 'Time Until Enforcement'}
                  </p>
                  <p className="countdown__time">{countdown}</p>
                </div>
              )}
            </section>

            {/* Zone Status */}
            <section className="zones" aria-label="Zone status">
              <h2 className="zones__title">Zone Status</h2>
              <div className="zones__grid">
                {/* Zone 1 */}
                <div className="zone-card">
                  <p className="zone-card__label">Zone 1</p>
                  <h3 className="zone-card__name">Central Halifax</h3>
                  <div
                    className={`zone-card__status ${status.zone1Active
                      ? 'zone-card__status--active'
                      : 'zone-card__status--inactive'
                      }`}
                  >
                    <span
                      className={`zone-card__status-dot ${status.zone1Active
                        ? 'zone-card__status-dot--active'
                        : 'zone-card__status-dot--inactive'
                        }`}
                    ></span>
                    {status.zone1Active ? 'Ban Active' : 'No Ban'}
                  </div>
                  <p className="zone-card__description">
                    Downtown Halifax, Peninsula & Central Dartmouth
                  </p>
                </div>

                {/* Zone 2 */}
                <div className="zone-card">
                  <p className="zone-card__label">Zone 2</p>
                  <h3 className="zone-card__name">Non-Central</h3>
                  <div
                    className={`zone-card__status ${status.zone2Active
                      ? 'zone-card__status--active'
                      : 'zone-card__status--inactive'
                      }`}
                  >
                    <span
                      className={`zone-card__status-dot ${status.zone2Active
                        ? 'zone-card__status-dot--active'
                        : 'zone-card__status-dot--inactive'
                        }`}
                    ></span>
                    {status.zone2Active ? 'Ban Active' : 'No Ban'}
                  </div>
                  <p className="zone-card__description">
                    Bedford, Sackville, Cole Harbour & Surrounding Areas
                  </p>
                </div>
              </div>

              {/* Zone Map Section */}
              <div className="zone-map-section">
                <p className="zone-map-section__label">Not sure which zone you're in?</p>
                <button
                  className="zone-map-card"
                  onClick={() => setMapLightboxOpen(true)}
                  aria-label="View zone map in full screen"
                >
                  <img
                    src="https://cdn.halifax.ca/sites/default/files/pages/in-content/2022-12/winter-parking-ban-zone-map-zone-1-and-zone-2.jpg"
                    alt="Halifax Winter Parking Ban Zone Map showing Zone 1 (Central) and Zone 2 (Non-Central) boundaries"
                    className="zone-map-card__image"
                    loading="lazy"
                  />
                  <div className="zone-map-card__overlay">
                    <span className="zone-map-card__overlay-text">Tap to enlarge</span>
                  </div>
                </button>
                <p className="zone-map-section__source">
                  Source:{' '}
                  <a
                    href="https://www.halifax.ca/transportation/winter-operations/parking-ban"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Halifax.ca
                  </a>
                </p>
              </div>
            </section>

            {/* Info Section */}
            <section className="info-section" aria-label="Additional information">
              <div className="info-card">
                <h3 className="info-card__title">
                  What You Need to Know
                </h3>
                <div className="info-card__content">
                  <p>
                    The overnight winter parking ban is enforced from{' '}
                    <span className="info-card__highlight">1:00 AM to 6:00 AM</span>{' '}
                    during winter weather events to allow crews to clear streets.
                  </p>
                  <p>
                    Vehicles parked on municipal streets during enforcement may be{' '}
                    <span className="info-card__highlight">ticketed ($50 fine)</span>{' '}
                    or <span className="info-card__highlight">towed</span>.
                  </p>
                  <p>
                    The ban applies to all municipal streets in the affected zones.
                    Private parking lots and driveways are not affected.
                  </p>
                </div>
              </div>
            </section>

            {/* Share Button */}
            <section className="share-section">
              <button className="share-button" onClick={handleShare}>
                Share Status
              </button>
            </section>

            {/* Last Updated */}
            <p className="last-updated">
              Last updated: {formatRelativeTime(status.lastUpdate)}
              {' · '}
              <a
                href={status.link || 'https://www.halifax.ca/transportation/winter-operations/parking-ban'}
                target="_blank"
                rel="noopener noreferrer"
              >
                View source
              </a>
            </p>
          </>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="footer">
        <div className="container">
          <p className="footer__content">
            Data from{' '}
            <a
              href="https://www.halifax.ca"
              target="_blank"
              rel="noopener noreferrer"
              className="footer__link"
            >
              Halifax.ca
            </a>
            <span className="footer__divider">·</span>
            <a
              href="https://github.com/Gorskiz/Halifax-Parking-Ban"
              target="_blank"
              rel="noopener noreferrer"
              className="footer__link"
            >
              Open Source
            </a>
          </p>
          <p className="footer__disclaimer">
            Not an official Halifax Regional Municipality website. Community built and maintained.
          </p>
        </div>
      </footer>

      {/* Zone Map Lightbox Modal */}
      {mapLightboxOpen && (
        <div
          className="lightbox"
          onClick={() => setMapLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Zone map enlarged view"
        >
          <button
            className="lightbox__close"
            onClick={() => setMapLightboxOpen(false)}
            aria-label="Close map"
          >
            Close
          </button>
          <img
            src="https://cdn.halifax.ca/sites/default/files/pages/in-content/2022-12/winter-parking-ban-zone-map-zone-1-and-zone-2.jpg"
            alt="Halifax Winter Parking Ban Zone Map showing Zone 1 (Central) and Zone 2 (Non-Central) boundaries"
            className="lightbox__image"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Toast Notification */}
      <div
        className={`toast ${toastVisible ? 'toast--visible' : ''}`}
        role="alert"
        aria-live="assertive"
      >
        {toastMessage}
      </div>
    </div>
  );
}

export default App;
