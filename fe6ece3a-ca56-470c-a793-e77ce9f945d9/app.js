(function (window, document) {
  const widget_ids = ['fe6ece3a-ca56-470c-a793-e77ce9f945d9'];
  const img_urls = ['https://imgad.strossle.com/img?pid=fe6ece3a-ca56-470c-a793-e77ce9f945d9&slot=1']

  let container = document.getElementsByClassName('newsletter')[0];

  img_urls.forEach((iu) => injectPicassoIntegration(iu, container));

  function injectPicassoIntegration (img_url, parent_element) {
    const div = document.createElement('div');
    const a = document.createElement('a');
    const img = document.createElement('img');

    a.appendChild(img);
    img.src = img_url;
    div.appendChild(a);

    div.className = 'integration';

    parent_element.appendChild(div);

    return parent_element.children[parent_element.children.length - 1];
  }
}(window, window.document));
