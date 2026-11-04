"""Removal-request identifiers come from private KB configuration, never from source."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hardissoft_kb import catalog, privacy

CONFIG_NAME = 'privacy-request-identifiers.json'


class RequestIdentifierConfigurationTests(unittest.TestCase):
    def _root(self, content):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / 'config').mkdir()
        (root / 'config' / CONFIG_NAME).write_text(content, encoding='utf-8')
        return root

    def test_configured_identifiers_are_redacted_as_whole_words_in_any_case(self):
        root = self._root(json.dumps(['Example Person', 'ExampleCo']))
        with patch.object(catalog, 'ROOT', root):
            result = privacy.redact('Ask example person at EXAMPLECO; Example Personnel stays.')
        self.assertEqual(result['text'], 'Ask [REDACTED:identifier] at [REDACTED:identifier]; Example Personnel stays.')

    def test_malformed_configuration_fails_closed(self):
        for content in ('{"name": "Example Person"}', '["Example Person", " "]', 'not json'):
            with self.subTest(content=content):
                root = self._root(content)
                with patch.object(catalog, 'ROOT', root), self.assertRaises(ValueError):
                    privacy.redact('Example Person')


if __name__ == '__main__':
    unittest.main()
