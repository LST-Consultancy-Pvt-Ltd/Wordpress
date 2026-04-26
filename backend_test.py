import requests
import sys
import json
from datetime import datetime

class WordPressManagementTester:
    def __init__(self, base_url="https://goofy-chandrasekhar-3.preview.emergentagent.com"):
        self.base_url = f"{base_url}/api"
        self.tests_run = 0
        self.tests_passed = 0
        self.token = None
        self.site_id = None

    def run_test(self, name, method, endpoint, expected_status, data=None, params=None):
        """Run a single API test"""
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'

        self.tests_run += 1
        print(f"\n🔍 Testing {name}...")
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, params=params)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, params=params)
            elif method == 'PUT':
                response = requests.put(url, json=data, headers=headers)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers)

            success = response.status_code == expected_status
            if success:
                self.tests_passed += 1
                print(f"✅ Passed - Status: {response.status_code}")
                try:
                    return success, response.json() if response.text else {}
                except:
                    return success, {}
            else:
                print(f"❌ Failed - Expected {expected_status}, got {response.status_code}")
                try:
                    error_data = response.json()
                    print(f"   Error: {error_data}")
                except:
                    print(f"   Raw response: {response.text}")

            return success, {}

        except Exception as e:
            print(f"❌ Failed - Error: {str(e)}")
            return False, {}

    def test_root_endpoint(self):
        """Test root API endpoint"""
        return self.run_test("Root API", "GET", "/", 200)

    def test_dashboard_stats(self):
        """Test dashboard stats endpoint"""
        return self.run_test("Dashboard Stats", "GET", "/dashboard/stats", 200)

    def test_settings_endpoints(self):
        """Test settings endpoints"""
        # Get settings
        success, data = self.run_test("Get Settings", "GET", "/settings", 200)
        if not success:
            return False

        # Update settings with OpenAI key
        settings_data = {"openai_api_key": "sk-test-key-for-testing"}
        success, _ = self.run_test("Update Settings", "POST", "/settings", 200, settings_data)
        return success

    def test_sites_endpoints(self):
        """Test sites management endpoints"""
        # Get sites (should be empty initially)
        success, data = self.run_test("Get Sites", "GET", "/sites", 200)
        if not success:
            return False

        # Create test site
        site_data = {
            "name": "Test WordPress Site",
            "url": "https://demo.wp-api.org",
            "username": "demo",
            "app_password": "demo-password"
        }
        success, response_data = self.run_test("Create Site", "POST", "/sites", 200, site_data)
        
        if success and response_data:
            self.site_id = response_data.get("id")
            print(f"   Created site with ID: {self.site_id}")
            
            # Get specific site
            if self.site_id:
                success, _ = self.run_test("Get Site by ID", "GET", f"/sites/{self.site_id}", 200)
                
        return success

    def test_ai_command_endpoints(self):
        """Test AI command endpoints"""
        if not self.site_id:
            print("⚠️  Skipping AI Command tests - no site ID available")
            return True

        # Execute AI command
        command_data = {
            "site_id": self.site_id,
            "command": "Analyze this WordPress site and provide suggestions"
        }
        success, response_data = self.run_test("Execute AI Command", "POST", "/ai/command", 200, command_data)
        
        if success:
            # Get AI commands for site
            success, _ = self.run_test("Get AI Commands", "GET", f"/ai/commands/{self.site_id}", 200)
            
        return success

    def test_pages_endpoints(self):
        """Test pages management endpoints"""
        if not self.site_id:
            print("⚠️  Skipping Pages tests - no site ID available")
            return True

        # Get pages
        success, _ = self.run_test("Get Pages", "GET", f"/pages/{self.site_id}", 200)
        
        # Create page
        page_data = {
            "site_id": self.site_id,
            "title": "Test Page",
            "content": "<h1>Test Page Content</h1><p>This is a test page.</p>",
            "status": "draft"
        }
        success, _ = self.run_test("Create Page", "POST", "/pages", 200, page_data)
        
        return success

    def test_posts_endpoints(self):
        """Test posts management endpoints"""
        if not self.site_id:
            print("⚠️  Skipping Posts tests - no site ID available")
            return True

        # Get posts
        success, _ = self.run_test("Get Posts", "GET", f"/posts/{self.site_id}", 200)
        
        # Generate blog post
        success, _ = self.run_test("Generate Blog Post", "POST", f"/posts/generate?site_id={self.site_id}&topic=WordPress+Security", 200)
        
        # Create post
        post_data = {
            "site_id": self.site_id,
            "title": "Test Blog Post",
            "content": "<h1>Test Post</h1><p>This is a test blog post.</p>",
            "status": "draft"
        }
        success, _ = self.run_test("Create Post", "POST", "/posts", 200, post_data)
        
        return success

    def test_seo_endpoints(self):
        """Test SEO management endpoints"""
        if not self.site_id:
            print("⚠️  Skipping SEO tests - no site ID available")
            return True

        # Get SEO metrics
        success, _ = self.run_test("Get SEO Metrics", "GET", f"/seo/{self.site_id}", 200)
        
        # Analyze SEO
        success, _ = self.run_test("Analyze SEO", "POST", f"/seo/analyze/{self.site_id}?page_url=https://demo.wp-api.org", 200)
        
        # Self-heal SEO
        success, _ = self.run_test("Self-Heal SEO", "POST", f"/seo/self-heal/{self.site_id}", 200)
        
        return success

    def test_navigation_endpoints(self):
        """Test navigation management endpoints"""
        if not self.site_id:
            print("⚠️  Skipping Navigation tests - no site ID available")
            return True

        # Get navigation
        success, _ = self.run_test("Get Navigation", "GET", f"/navigation/{self.site_id}", 200)
        
        # Sync navigation
        success, _ = self.run_test("Sync Navigation", "POST", f"/navigation/{self.site_id}/sync", 200)
        
        return success

    def test_content_refresh_endpoints(self):
        """Test content refresh endpoints"""
        if not self.site_id:
            print("⚠️  Skipping Content Refresh tests - no site ID available")
            return True

        # Get content refresh items
        success, _ = self.run_test("Get Content Refresh Items", "GET", f"/content-refresh/{self.site_id}", 200)
        
        # Scan for refresh
        success, _ = self.run_test("Scan for Refresh", "POST", f"/content-refresh/{self.site_id}/scan", 200)
        
        return success

    def test_activity_endpoints(self):
        """Test activity logging endpoints"""
        # Get all activity logs
        success, _ = self.run_test("Get All Activity Logs", "GET", "/activity", 200)
        
        if self.site_id:
            success, _ = self.run_test("Get Site Activity Logs", "GET", f"/activity/{self.site_id}", 200)
        
        return success

    def cleanup(self):
        """Clean up test data"""
        if self.site_id:
            print(f"\n🧹 Cleaning up test site {self.site_id}...")
            success, _ = self.run_test("Delete Test Site", "DELETE", f"/sites/{self.site_id}", 200)
            return success
        return True

def main():
    """Run all backend tests"""
    print("🚀 Starting WordPress Management Platform Backend Tests")
    print("=" * 60)
    
    tester = WordPressManagementTester()
    
    try:
        # Core API tests
        test_results = [
            tester.test_root_endpoint(),
            tester.test_dashboard_stats(),
            tester.test_settings_endpoints(),
            tester.test_sites_endpoints(),
            tester.test_ai_command_endpoints(),
            tester.test_pages_endpoints(),
            tester.test_posts_endpoints(),
            tester.test_seo_endpoints(),
            tester.test_navigation_endpoints(),
            tester.test_content_refresh_endpoints(),
            tester.test_activity_endpoints()
        ]
        
        # Clean up
        cleanup_success = tester.cleanup()
        
        # Print summary
        print("\n" + "=" * 60)
        print("📊 TEST SUMMARY")
        print("=" * 60)
        print(f"Total tests run: {tester.tests_run}")
        print(f"Tests passed: {tester.tests_passed}")
        print(f"Tests failed: {tester.tests_run - tester.tests_passed}")
        print(f"Success rate: {(tester.tests_passed / tester.tests_run * 100):.1f}%")
        
        if cleanup_success:
            print("✅ Cleanup completed successfully")
        else:
            print("⚠️  Cleanup had issues")
            
        # Return exit code
        return 0 if tester.tests_passed == tester.tests_run else 1
        
    except Exception as e:
        print(f"💥 Critical error during testing: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())