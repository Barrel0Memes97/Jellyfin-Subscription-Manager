"""Optional real-browser lifecycle smoke test: python scripts/check_banner_lifecycle.py
Requires `playwright` plus a local Chromium. Runs against a mocked Jellyfin UI/API,
not a live Jellyfin server. No outgoing network traffic is made.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BANNER = (ROOT / 'Jellyfin.SubscriptionManager/Configuration/banner.js').read_text()
PANEL = '#jf-personalized-user-banner'


def check(condition, explanation):
    if not condition:
        raise AssertionError(explanation)
    print('PASS:', explanation)


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page()
        page.set_content('''<html><head></head><body>
            <header id="jf-app-header">Jellyfin top navigation</header>
            <main id="indexPage"><div id="homeTab" class="tabContent is-active">
              <div class="homePageMain">
                <div id="slides-container">Media Bar slideshow</div>
                <div class="homeSectionsContainer"><div>Movie rows</div></div>
              </div>
            </div></main>
        </body></html>''')
        page.evaluate('''() => {
          location.hash = '/home';
          Object.defineProperty(document, 'currentScript', {
             configurable: true, get: () => ({src: 'https://jellyfin.example/SubscriptionManager/banner.js?v=0.2.5.0'})
          });
          window.bannerRequests = 0;
          window.userId = 'alice';
          window.mockBanner = {
            show:true, status:'active', userName:'Alice', plan:'Basic',
            appearance:{layout:'home', dismissible:true, refreshMinutes:5, titleTemplate:'Welcome, {name}!'}
          };
          window.ApiClient = {
            getCurrentUserId: () => window.userId,
            ajax: async () => { window.bannerRequests++; return {...window.mockBanner}; }
          };
        }''')
        page.evaluate(BANNER)
        page.locator(PANEL).wait_for(timeout=3000)
        check(page.locator(PANEL).count() == 1, 'Banner mounts once on initial Home route')
        check('Welcome, Alice!' in page.locator(PANEL).inner_text(), 'Correct user name is shown')
        check(page.evaluate('''() => document.querySelector('.homePageMain').firstElementChild.id''') == PANEL.lstrip("#"),
              'Top prepends to the same .homePageMain as the original injected script')
        check(page.evaluate('''() => document.querySelector('.homePageMain').firstElementChild.id''') == PANEL.lstrip('#'),
              'Top banner is directly above the Media Bar')
        check(page.evaluate('''() => document.getElementById('jf-app-header').compareDocumentPosition(document.getElementById('jf-personalized-user-banner')) & Node.DOCUMENT_POSITION_FOLLOWING''') != 0,
              'Jellyfin top menu stays above the banner')

        # Reproduce the v0.2.4.5 failure: the parent of #homeTab allows
        # only the active tab as a visible child after initialization. A
        # banner inserted as a sibling is connected but CSS-invisible.
        page.add_style_tag(content='#indexPage > :not(#homeTab) { display:none !important; }')
        page.wait_for_timeout(300)
        check(page.locator(PANEL).is_visible(),
              'Home tab sibling visibility rules cannot hide the Top banner')

        # The position setting must change actual DOM placement on Home.
        page.evaluate('''() => {
          window.mockBanner.appearance = {...window.mockBanner.appearance, position:'bottom'};
          window.mockBanner.customColor = '#336699';
          window.mockBanner.customMessage = 'Special note for {name}';
          document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(150)
        check(page.evaluate('''() => document.querySelector('.homeSectionsContainer').lastElementChild.id''') == PANEL.lstrip("#"),
              'Bottom position places inline banner after Home content')
        check('Special note for Alice' in page.locator(PANEL).inner_text(),
              'Personal active message renders with substitutions')
        check('51, 102, 153' in page.locator(PANEL).get_attribute('style') or '#336699' in page.locator(PANEL).get_attribute('style'),
              'Personal active color overrides shared active color')

        page.evaluate('''() => {
          window.mockBanner.status = 'expiring';
          window.mockBanner.appearance = {...window.mockBanner.appearance,
            expiringText:'Your renewal is approaching', expiringColor:'#92400e'};
          document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(150)
        check('Your renewal is approaching' in page.locator(PANEL).inner_text() and
              'Special note' not in page.locator(PANEL).inner_text(),
              'Expiration warning takes precedence over personal active message')
        check('146, 64, 14' in page.locator(PANEL).get_attribute('style') or '#92400e' in page.locator(PANEL).get_attribute('style'),
              'Expiration warning color takes precedence over personal active color')

        # Floating notifications must switch edges, without retaining the old style.
        page.evaluate('''() => {
          window.mockBanner.status = 'active';
          window.mockBanner.appearance = {...window.mockBanner.appearance,
            layout:'floating', position:'bottom'};
          document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).evaluate('el => el.parentElement === document.body && !!el.style.bottom && !el.style.top'),
              'Floating bottom is fixed to the lower screen edge')
        page.evaluate('''() => {
          window.mockBanner.appearance.position = 'top';
          document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).evaluate('el => !!el.style.top && !el.style.bottom'),
              'Floating top resets the previous bottom placement')
        page.evaluate('''() => {
          window.mockBanner.appearance = {...window.mockBanner.appearance,
            layout:'home', position:'top'};
          document.dispatchEvent(new Event('visibilitychange'));
        }''')
        page.wait_for_timeout(150)
        check(page.evaluate('''() => document.querySelector('.homePageMain').firstElementChild.id''') == PANEL.lstrip("#"),
              'Switching back to inline top prepends into .homePageMain')

        # Media Bar plugins may insert their hero after the subscription banner is loaded.
        page.evaluate('''() => {
          const bar = document.querySelector('#slides-container');
          bar.remove();
          const middle = document.createElement('div'); middle.id = 'home-intro';
          document.querySelector('.homePageMain').prepend(middle);
          document.querySelector('.homePageMain').append(bar);
        }''')
        page.wait_for_timeout(150)
        check(page.evaluate('''() => document.querySelector('.homePageMain').firstElementChild.id''') == PANEL.lstrip('#'),
              'Late-added media bar stays below banner after observer prepends it')

        # Reproduce the Top-only regression: Media Bar replaces its internal
        # wrapper many times. The banner must remain outside the slideshow
        # wrapper, using the original .homePageMain placement.
        page.evaluate('''() => {
          const tab = document.querySelector('#homeTab');
          const media = tab.querySelector('#slides-container');
          const wrapper = document.createElement('section');
          wrapper.className = 'media-bar-react-wrapper';
          media.replaceWith(wrapper);
          wrapper.appendChild(media);
          window.stableBannerNode = document.querySelector('#jf-personalized-user-banner');
          window.bannerWasDisconnected = false;
          window.bannerWasInsideMedia = false;
          window.bannerTrackedChanges = 0;
          const check = () => {
            const banner = window.stableBannerNode;
            if (!banner.isConnected) window.bannerWasDisconnected = true;
            if (document.querySelector('.media-bar-react-wrapper')?.contains(banner)) window.bannerWasInsideMedia = true;
          };
          window.mediaBarSimulator = setInterval(() => {
            const hero = tab.querySelector('.media-bar-react-wrapper');
            if (hero) {
              const next = hero.cloneNode(true);
              hero.replaceWith(next);
            }
            window.bannerTrackedChanges++;
            check();
          }, 20);
          window.testBannerObserver = new MutationObserver(check);
          window.testBannerObserver.observe(document.body, {childList:true, subtree:true});
        }''')
        page.wait_for_timeout(700)
        page.evaluate('''() => {clearInterval(window.mediaBarSimulator); window.testBannerObserver.disconnect();}''')
        check(page.evaluate('bannerTrackedChanges') >= 20,
              'Simulated Media Bar repeatedly replacing its internal React wrapper')
        check(page.evaluate('!bannerWasDisconnected && !bannerWasInsideMedia'),
              'Top banner stays connected outside the replaced slideshow wrapper')
        check(page.evaluate('stableBannerNode === document.querySelector("#jf-personalized-user-banner")'),
              'Repeated Media Bar redraws preserve the same banner element')

        # React-like replacement of home content, without touching body immediate child list.
        requests_before_remount = page.evaluate('bannerRequests')
        page.evaluate('''() => {
          document.querySelector('.homePageMain').innerHTML =
            '<div id="slides-container">New Media Bar</div><div class="homeSectionsContainer"><div>New movie rows</div></div>';
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 1, 'Banner remounts after nested React page rebuild')
        check(page.evaluate('bannerRequests') == requests_before_remount, 'DOM repairs do not cause extra API requests')

        # Removal of all home structure and later mount on the same route.
        page.evaluate('''() => {
          document.querySelector('#indexPage').replaceChildren();
          const tab = document.createElement('div');
          tab.id = 'homeTab'; tab.className = 'tabContent is-active';
          tab.innerHTML = '<div class="homePageMain"><div id="slides-container">Fresh Media Bar</div><div class="homeSectionsContainer">Fresh Home</div></div>';
          document.querySelector('#indexPage').append(tab);
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 1, 'Banner survives replacement of the entire Home tab')

        # Jellyfin 12 may retain a hidden duplicate #indexPage *before* the
        # actually visible instance. The banner must never be moved to it.
        page.evaluate('''() => {
          const cached = document.createElement('main');
          cached.id = 'indexPage'; cached.className = 'hide';
          cached.innerHTML = '<div id="homeTab"><div class="homePageMain">Stale home cache</div></div>';
          document.body.insertBefore(cached, document.querySelector('#indexPage'));
          window.cachedHome = cached;
        }''')
        page.wait_for_timeout(170)
        check(page.locator(PANEL).count() == 1 and page.locator(PANEL).is_visible(),
              'Top banner remains visible with a hidden duplicate Home page')
        check(page.locator(PANEL).evaluate('el => !window.cachedHome.contains(el)'),
              'Top anchor chooses live Home over a stale cached #indexPage')
        page.evaluate('window.cachedHome.remove()')

        # A real disappearing banner can be diagnosed with this safe helper.
        diagnostic = page.evaluate('window.__subscriptionManagerBannerDebug()')
        check(diagnostic['bannerConnected'] and diagnostic['bannerVisible']
              and diagnostic['homeContainerVisible'] and not diagnostic['dismissed'],
              'Built-in diagnostics confirm live Home anchor and visible banner')
        check(diagnostic['requestedPosition'] == 'top',
              'Diagnostics report the currently configured banner position')
        # Regression for the reported ~1-second disappearance after refresh.
        page.wait_for_timeout(1800)
        check(page.locator(PANEL).count() == 1 and page.locator(PANEL).is_visible(),
              'Banner stays visible after startup/Media Bar settling period')

        # SPA navigation away, then back; tab can remain cached while hidden.
        page.evaluate("() => {location.hash = '/details?id=42'; dispatchEvent(new Event('hashchange'));}")
        page.wait_for_timeout(100)
        check(page.locator(PANEL).count() == 0, 'Banner is hidden on item-details page')
        page.evaluate("() => {location.hash = '/home'; dispatchEvent(new Event('hashchange'));}")
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 1, 'Banner remounts after navigating back Home')

        # Dismissal cannot be undone by a DOM re-render.
        page.locator(PANEL + ' .jf-banner-close').click()
        page.wait_for_timeout(250)
        check(page.locator(PANEL).count() == 0, 'Close button dismisses banner')
        page.evaluate('''() => { document.querySelector('#homeTab').append(document.createElement('div')); }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 0, 'Dismissed banner stays hidden through DOM mutations')

        # User switch invalidates previous data, user-specific dismissal, and shows new name.
        page.evaluate('''() => {
          window.userId = 'bob';
          window.mockBanner = {...window.mockBanner, userName: 'Bob'};
          document.dispatchEvent(new Event('HISTORY_UPDATE'));
        }''')
        page.wait_for_timeout(200)
        check(page.locator(PANEL).count() == 1, 'New account gets its own banner')
        check('Welcome, Bob!' in page.locator(PANEL).inner_text(), 'No previous subscriber data leaks on account switch')

        # Logging out hides the banner without waiting for a timer.
        page.evaluate('''() => {
          window.userId = null;
          document.dispatchEvent(new Event('HISTORY_UPDATE'));
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 0, 'Banner disappears when user logs out')
    finally:
        browser.close()
