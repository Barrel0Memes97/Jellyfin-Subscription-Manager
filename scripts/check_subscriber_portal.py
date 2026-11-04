"""Optional Chromium smoke test for subscriber portal (mocked Jellyfin Web).
Run locally: python3 scripts/check_subscriber_portal.py
Not run in GitHub Actions because Chromium/Playwright are optional dependencies.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

source = (Path(__file__).resolve().parents[1] / 'Jellyfin.SubscriptionManager/Configuration/account.js').read_text()

def check(yes, description):
    if not yes:
        raise AssertionError(description)
    print('PASS:', description)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page()
        page.set_content('<html><head></head><body><header><button class="headerUserButton">Alice</button></header><main id="indexPage">Home</main></body></html>')
        page.evaluate('''() => {
          location.hash='/home';
          window.currentId='alice';
          window.accountCalls=[];
          window.accountRecord={
            name:'Alice',status:'active',managed:true,
            plan:{id:'00000000-0000-0000-0000-000000000001',name:'Basic',description:'Watch-only',monthlyCents:200},
            balanceCents:950,paidThrough:'2027-01-31',renewalOn:'2027-02-05',billingCycle:'firstFriday',
            availablePlans:[
              {id:'00000000-0000-0000-0000-000000000001',name:'Basic',description:'Watch-only',monthlyCents:200,selectable:true},
              {id:'00000000-0000-0000-0000-000000000002',name:'Premium',description:'Media requests',monthlyCents:500,selectable:true}
            ], pendingPlan:null, banner:{title:'Hello Alice!',color:'#123456',message:'Welcome back'},
            transactions:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',kind:'deposit',amountCents:1000,balanceAfterCents:1000,createdUtc:'2026-11-03T00:00:00Z',note:'Test deposit'}]
          };
          window.ApiClient={
            getCurrentUserId:()=>window.currentId,
            getUrl:path=>'/api/'+path,
            ajax:async request=>{
              window.accountCalls.push(request);
              if(request.type==='GET')return structuredClone(window.accountRecord);
              if(request.url.endsWith('/plan-request')){
                window.accountRecord.pendingPlan={id:'00000000-0000-0000-0000-000000000002',name:'Premium',monthlyCents:500};
              }
              if(request.url.endsWith('/banner')){
                window.accountRecord.banner=JSON.parse(request.data);
              }
              return {success:true};
            }
          };
        }''')
        page.evaluate(source)
        page.locator('#jf-subscription-account-entry').wait_for(timeout=5000)
        check(page.locator('#jf-subscription-account-entry').count() == 1, 'A single My Subscription shortcut appears in the Jellyfin header')
        page.locator('#jf-subscription-account-entry').click()
        page.locator('#jf-subscription-account-page').wait_for(timeout=5000)
        check('$9.50' in page.locator('#jf-subscription-account-page').inner_text(), 'Only personal account balance is displayed')
        check('2027-02-05' in page.locator('#jf-subscription-account-page').inner_text(), 'Next renewal date is shown')
        check('Test deposit' in page.locator('#jf-subscription-account-page').inner_text(), 'Account transaction history renders')
        page.locator('#sma-plan').select_option('00000000-0000-0000-0000-000000000002')
        page.on('dialog', lambda dialog: dialog.accept())
        page.locator('#sma-plan-form button[type=submit]').click()
        page.wait_for_timeout(200)
        check('Awaiting administrator approval' in page.locator('#jf-subscription-account-page').inner_text(), 'Plan request stays pending instead of applying immediately')
        check(page.locator('#sma-plan').is_disabled(), 'Duplicate request submission is disabled')
        page.locator('#sma-banner-title').fill('Welcome again, Alice!')
        page.locator('#sma-banner-message').fill('Personal note')
        page.locator('#sma-banner-color').fill('#aabbcc')
        page.locator('#sma-banner-default').uncheck()
        page.locator('#sma-banner-form button[type=submit]').click()
        page.wait_for_timeout(180)
        check(page.evaluate("window.accountRecord.banner.color") == '#aabbcc', 'Personalized banner can be saved')
        # Admin page customization is supplied by the current-user API only.
        page.evaluate('''() => {
          window.accountRecord.page={enabled:true,title:'Member Center',subtitle:'Welcome to your account',
            welcomeMessage:'Thanks for supporting us!',supportMessage:'Contact the server owner to pay.',
            accentColor:'#aabbcc',cardColor:'#334455',showBalance:false,showPlan:true,
            showPaidThrough:false,showRenewal:true,showPlanDetails:false,
            allowPlanRequests:false,allowBannerCustomization:false,showTransactions:false,
            showLauncher:true,showBannerLink:true};
        }''')
        page.locator('#sma-reload').click()
        page.wait_for_timeout(180)
        check(page.locator('#sma-page-title').inner_text()=='Member Center', 'Custom admin-set page title appears')
        check('Thanks for supporting us!' in page.locator('#jf-subscription-account-page').inner_text(), 'Custom welcome message is visible')
        check(page.locator('#sma-plan-form').count() == 0, 'Disabled plan change section is absent')
        check(page.locator('#sma-banner-form').count() == 0, 'Disabled banner editor is absent')
        check(page.locator('.sma-table').count() == 0, 'Hidden transactions are absent')
        check('$9.50' not in page.locator('#jf-subscription-account-page').inner_text(), 'Credit is hidden when administrator chooses')
        page.locator('#sma-close').click()
        page.evaluate("() => { location.hash='/home?smAccount=1'; dispatchEvent(new Event('hashchange')); }")
        page.locator('#jf-subscription-account-page').wait_for(timeout=3000)
        check(page.locator('#sma-page-title').inner_text()=='Member Center', 'KefinTweaks Home deep link opens customized portal')
        page.locator('#sma-close').click()
        check(page.evaluate("location.hash") == '#/home', 'Closing deep link returns to valid Jellyfin Home route')
        requests = page.evaluate('window.accountCalls')
        check(all('/account/' in req['url'] for req in requests), 'Subscriber page uses only scoped account endpoints')
        check(not any('/users/' in req['url'] or '/payments' in req['url'] or '/overview' in req['url'] for req in requests), 'No administrator-only API calls are made')
        page.evaluate("() => {window.currentId='bob';document.body.appendChild(document.createElement('aside'));}")
        page.wait_for_timeout(160)
        check(page.locator('#jf-subscription-account-page').count() == 0, 'Changing users closes the previous account panel')
        page.evaluate("() => {location.hash='/login';document.body.appendChild(document.createElement('aside'));}")
        page.wait_for_timeout(160)
        check(page.locator('#jf-subscription-account-entry').count() == 0, 'Login removes My Subscription shortcut')
    finally:
        browser.close()
