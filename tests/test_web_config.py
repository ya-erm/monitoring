import unittest

from deploy.render_config import configuration


class WebConfigTests(unittest.TestCase):
    def test_default_stays_disabled_and_public_url_enables_dashboard(self):
        self.assertFalse(configuration()["enabled"])
        result = configuration("https://metrics.example.test/public/", " Test ")
        self.assertTrue(result["enabled"])
        self.assertEqual(result["dataBaseUrl"], "https://metrics.example.test/public")
        self.assertEqual(result["title"], "Test")

    def test_rejects_credentials_queries_and_insecure_urls(self):
        for url in ("http://metrics.example.test", "https://key:secret@metrics.example.test",
                    "https://metrics.example.test?token=secret", "https://metrics.example.test#secret"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                configuration(url)


if __name__ == "__main__":
    unittest.main()
