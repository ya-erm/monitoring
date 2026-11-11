import json
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

    def test_multiple_servers_use_public_fields_and_preserve_order(self):
        servers = [{"id": "first", "title": " First ", "dataBaseUrl": "https://metrics.example.test/first/"},
                   {"id": "second", "title": "Second", "dataBaseUrl": "https://metrics.example.test/second"}]
        result = configuration(servers_json=json.dumps(servers))
        self.assertTrue(result["enabled"])
        self.assertEqual(result["dataBaseUrl"], "https://metrics.example.test/first")
        self.assertEqual(result["title"], "First")
        self.assertEqual([server["id"] for server in result["servers"]], ["first", "second"])

    def test_server_list_rejects_secrets_duplicates_and_invalid_values(self):
        valid = {"id": "first", "title": "First", "dataBaseUrl": "https://metrics.example.test/first"}
        for values in ({}, [], [valid, valid], [{**valid, "secret": "private"}],
                       [{**valid, "id": "../unsafe"}], [{**valid, "title": " "}],
                       [{**valid, "dataBaseUrl": ""}], [{**valid, "dataBaseUrl": "http://example.test"}]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                configuration(servers_json=json.dumps(values))


if __name__ == "__main__":
    unittest.main()
