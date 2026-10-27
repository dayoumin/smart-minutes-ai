import json
import time
import unittest
from unittest.mock import MagicMock, patch

import ollama_catalog as catalog


def search_page(cards, *, has_more=False):
    rows = []
    for name, capability in cards:
        rows.append(f'<li><a href="/library/{name}"><h2>{name}</h2>'
                    f'<p title="Official {name}">description</p><span>{capability}</span></a></li>')
    return (f'<p data-result-count="{len(cards)}" data-has-more="{str(has_more).lower()}"></p>'
            '<ul role="list">' + ''.join(rows) + '</ul>')


def tags_page(family, tags):
    return ''.join(f'<a href="/library/{family}:{tag}">{family}:{tag} • 1.3GB • Text input</a>'
                   f'<a href="/library/{family}:{tag}">{family}:{tag}</a>' for tag in tags)


class OllamaCatalogTest(unittest.TestCase):
    def read_fixture(self, url, deadline, **kwargs):
        if '/search?' in url:
            return search_page([('llama3.2', 'tools'), ('embed', 'embedding')])
        if url.endswith('/tags'):
            return tags_page('llama3.2', ['latest', '1b', '3b', '3b-cloud'])
        return json.dumps({'layers': [{'mediaType': 'application/vnd.ollama.image.model', 'size': 100}]})

    def test_search_returns_only_real_tags_with_metadata_and_deduplicates(self):
        with patch.object(catalog, '_read', side_effect=self.read_fixture) as read:
            result = catalog.search_summary_models('llama3.2')
        self.assertEqual([row['model'] for row in result['models']],
                         ['llama3.2:1b', 'llama3.2:3b', 'llama3.2:latest'])
        self.assertEqual(result['models'][0]['size'], '1.3GB')
        self.assertEqual(result['source'], 'https://ollama.com')
        self.assertFalse(result['has_more'])
        self.assertEqual(read.call_count, 2)
        self.assertIn('c=local', read.call_args_list[0].args[0])

    def test_exact_tag_filters_without_guessing_unknown_tags(self):
        with patch.object(catalog, '_read', side_effect=self.read_fixture):
            result = catalog.search_summary_models('llama3.2:3b')
            missing = catalog.search_summary_models('llama3.2:100b')
        self.assertEqual([row['model'] for row in result['models']], ['llama3.2:3b'])
        self.assertEqual(missing['models'], [])
        self.assertFalse(result['has_more'])

    def test_invalid_queries_never_access_network(self):
        for query in ('', '--help', 'https://evil.invalid/model', '../llama', 'llama:3b:cloud', 'a' * 81):
            with self.subTest(query=query), patch.object(catalog, '_read') as read:
                with self.assertRaises(catalog.CatalogSelectionError):
                    catalog.search_summary_models(query)
                read.assert_not_called()

    def test_empty_and_community_only_results_are_honest_empty_results(self):
        for html in ('<p data-result-count="0" data-has-more="false"></p>',
                     '<p data-result-count="1"></p><li><a href="/user/model"><h2>model</h2></a></li>'):
            with self.subTest(html=html), patch.object(catalog, '_read', return_value=html):
                self.assertEqual(catalog.search_summary_models('unknown')['models'], [])

    def test_changed_markup_is_failure_not_empty_success(self):
        for html in ('<html>upstream changed</html>', '<p data-result-count="2"></p><div>new cards</div>'):
            with self.subTest(html=html), patch.object(catalog, '_read', return_value=html):
                with self.assertRaises(catalog.CatalogUnavailableError):
                    catalog.search_summary_models('llama')
        with patch.object(catalog, '_read', side_effect=[search_page([('llama3.2', 'tools')]), '<html>new tags</html>']):
            with self.assertRaises(catalog.CatalogUnavailableError):
                catalog.search_summary_models('llama')

    def test_response_limits_bound_families_and_results(self):
        def read(url, deadline, **kwargs):
            if '/search?' in url:
                return search_page([(f'model{i}', 'tools') for i in range(10)])
            family = url.split('/')[-2]
            return tags_page(family, [f'{i}b' for i in range(20)])
        with patch.object(catalog, '_read', side_effect=read) as read:
            result = catalog.search_summary_models('model')
        self.assertEqual(len(result['models']), 16)
        self.assertTrue(result['has_more'])
        self.assertEqual(read.call_count, 4)

    def test_registration_verifies_official_tag_and_local_manifest_without_blobs(self):
        with patch.object(catalog, '_read', side_effect=self.read_fixture) as read:
            catalog.verify_summary_catalog_model('llama3.2:3b')
        self.assertEqual(read.call_count, 3)
        self.assertTrue(read.call_args.args[0].endswith('/manifests/3b'))
        self.assertTrue(read.call_args.kwargs['json_document'])
        self.assertFalse(any('/blobs/' in call.args[0] for call in read.call_args_list))

    def test_registration_refuses_cloud_embedding_community_missing_and_remote_models(self):
        for model in ('llama3.2:3b-cloud', 'embed:latest', 'user/model:latest', 'llama3.2:100b', 'llama3.2'):
            with self.subTest(model=model), patch.object(catalog, '_read', side_effect=self.read_fixture):
                with self.assertRaises(catalog.CatalogSelectionError):
                    catalog.verify_summary_catalog_model(model)
        with patch.object(catalog, '_read', side_effect=[search_page([('llama3.2', 'tools')]),
                                                       tags_page('llama3.2', ['3b']),
                                                       json.dumps({'layers': [{'mediaType': 'remote', 'size': 100}]})]):
            with self.assertRaises(catalog.CatalogSelectionError):
                catalog.verify_summary_catalog_model('llama3.2:3b')

    def test_non_text_capabilities_never_fetch_tags(self):
        for capability in ('embedding', 'decision', 'image'):
            with self.subTest(capability=capability), patch.object(catalog, '_read', return_value=search_page([('other', capability)])) as read:
                self.assertEqual(catalog.search_summary_models('other')['models'], [])
                self.assertEqual(read.call_count, 1)

    def test_registration_rejects_invalid_manifest_and_upstream_failure(self):
        for document in ('{invalid', '{}', 'null', '{"layers": {}}'):
            with self.subTest(document=document), patch.object(catalog, '_read', side_effect=[search_page([('llama3.2', 'tools')]),
                                                                                         tags_page('llama3.2', ['3b']), document]):
                with self.assertRaises(catalog.CatalogUnavailableError):
                    catalog.verify_summary_catalog_model('llama3.2:3b')
        with patch.object(catalog, '_read', side_effect=catalog.CatalogUnavailableError('offline')):
            with self.assertRaises(catalog.CatalogUnavailableError):
                catalog.search_summary_models('llama')

    def test_io_rejects_oversized_response_and_expired_deadline(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read1.side_effect = [b'x' * 65_536] * 31
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(catalog.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(catalog.CatalogUnavailableError):
                catalog._read('https://ollama.com/search?q=llama', time.monotonic() + 18)
            with self.assertRaises(catalog.CatalogUnavailableError):
                catalog._read('https://ollama.com/search?q=llama', time.monotonic() - 1)

    def test_redirect_rejects_untrusted_or_insecure_targets(self):
        redirect = catalog._OfficialRedirects()
        for url in ('https://evil.invalid/model', 'http://ollama.com/search', 'https://ollama.com@evil.invalid'):
            with self.subTest(url=url), self.assertRaises(catalog.CatalogUnavailableError):
                redirect.redirect_request(None, None, 302, '', {}, url)


if __name__ == '__main__':
    unittest.main()
