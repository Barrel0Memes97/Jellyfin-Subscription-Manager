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
              <div id="slides-container">Media Bar slideshow</div>
              <div class="homeSectionsContainer"><div>Movie rows</div></div>
            </div></main>
        </body></html>''')
        page.evaluate('''() => {
          location.hash = '/home';
          Object.defineProperty(document, 'currentScript', {
             configurable: true, get: () => ({src: 'https://jellyfin.example/SubscriptionManager/banner.js?v=0.2.4.4'})
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
        check(page.evaluate('''() => document.querySelector('#homeTab').firstElementChild.id''') == PANEL.lstrip("#"),
              'Top position places the banner immediately under the Home navigation')
        check(page.evaluate('''() => document.querySelector('#homeTab').firstElementChild.nextElementSibling.id''') == 'slides-container',
              'Top position places the banner directly ABOVE the Media Bar')
        check(page.evaluate('''() => document.getElementById('jf-app-header').compareDocumentPosition(document.getElementById('jf-personalized-user-banner')) & Node.DOCUMENT_POSITION_FOLLOWING''') != 0,
              'Jellyfin top menu stays above the banner')

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
        check(page.evaluate('''() => document.querySelector('#homeTab').firstElementChild.id''') == PANEL.lstrip("#"),
              'Switching back to inline top restores the media-bar-above placement')

        # Media Bar plugins may insert their hero after the subscription banner is loaded.
        page.evaluate('''() => {
          const bar = document.querySelector('#slides-container');
          bar.remove();
          const middle = document.createElement('div'); middle.id = 'home-intro';
          document.querySelector('#homeTab').prepend(middle);
          document.querySelector('#homeTab').append(bar);
        }''')
        page.wait_for_timeout(150)
        check(page.evaluate('''() => document.querySelector('#jf-personalized-user-banner').nextElementSibling.id''') == 'slides-container',
              'Late-added media bar stays directly after the banner')

        # React-like replacement of home content, without touching body immediate child list.
        requests_before_remount = page.evaluate('bannerRequests')
        page.evaluate('''() => {
          document.querySelector('#homeTab').innerHTML =
            '<div class="homeSectionsContainer"><div>New movie rows</div></div>';
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 1, 'Banner remounts after nested React page rebuild')
        check(page.evaluate('bannerRequests') == requests_before_remount, 'DOM repairs do not cause extra API requests')

        # Removal of all home structure and later mount on the same route.
        page.evaluate('''() => {
          document.querySelector('#indexPage').replaceChildren();
          const tab = document.createElement('div');
          tab.id = 'homeTab'; tab.className = 'tabContent is-active';
          tab.innerHTML = '<div class="homeSectionsContainer">Fresh Home</div>';
          document.querySelector('#indexPage').append(tab);
        }''')
        page.wait_for_timeout(150)
        check(page.locator(PANEL).count() == 1, 'Banner survives replacement of the entire Home tab')

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
