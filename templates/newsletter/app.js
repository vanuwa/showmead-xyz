(function (window, document) {
  const widget_ids = ['widget_id'];
  const img_urls = ['https://imgad.strossle.com/img?uid=[UID]&nid=[NID]&pid=[widget_id]&slot=[SLOT]']

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
